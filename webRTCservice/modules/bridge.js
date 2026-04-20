"use strict";

function createBridgeApi({
    sessions,
    pendingBridges,
    pendingInboundCalls,
    createSession,
    createPeerConnection,
    sendNotification,
    sendDataChannelMessage,
    startWebRtcBridge,
    destroySession,
    notiTypeCall,
    MediaStreamTrack,
    waitForIceGathering,
    formatIceCandidates,
    getRelayCandidates,
    embedCandidatesInSdp,
    applyInboundAnswer,
    RTCSessionDescription,
    logger = console,
}) {
    const ringGroups = new Map();
    const sessionToRingGroup = new Map();
    let nextRingGroupId = 1;

    function newRingGroupId() {
        const id = `mr-${Date.now()}-${nextRingGroupId}`;
        nextRingGroupId += 1;
        return id;
    }

    function getPendingList(walletKey) {
        const raw = pendingBridges.get(walletKey);
        if (!raw) return [];
        if (Array.isArray(raw)) return raw;
        return [raw];
    }

    function setPendingList(walletKey, list) {
        if (!list || list.length === 0) {
            pendingBridges.delete(walletKey);
            return;
        }
        pendingBridges.set(walletKey, list);
    }

    function addPendingEntry(walletKey, entry) {
        const list = getPendingList(walletKey);
        list.push(entry);
        setPendingList(walletKey, list);
    }

    function removePendingEntries(walletKey, predicate) {
        const list = getPendingList(walletKey).filter((entry) => !predicate(entry));
        setPendingList(walletKey, list);
    }

    function closeSessionNow(sessionId, reason = "multiring-cleanup") {
        const session = sessions.get(sessionId);
        if (!session) return;
        try {
            sendDataChannelMessage(sessionId, { msgType: "call", action: "end", reason });
        } catch (_) {}
        if (typeof destroySession === "function") {
            try { destroySession(sessionId, false); } catch (_) {}
        }
    }

    function getCallerNumberLabel(identity) {
        if (!identity || typeof identity !== "string") return "";
        const trimmed = identity.trim();
        if (!trimmed) return "";
        const atPos = trimmed.indexOf("@");
        if (atPos > 0) return trimmed.slice(0, atPos);
        const dotPos = trimmed.indexOf(".");
        if (dotPos > 0) return trimmed.slice(0, dotPos);
        return trimmed;
    }

    async function notifyAndBridge(callerSessionId, destination) {
        const callerSession = sessions.get(callerSessionId);
        if (!callerSession) throw new Error("Caller session not found");

        const calleeWallet = destination.wallet;
        const calleeEns = destination.ensName || calleeWallet;
        const callerEns = callerSession.callerEns;

        const BRIDGE_TIMEOUT = 60000;
        const bridgePromise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                removePendingEntries(calleeWallet.toLowerCase(), (entry) => entry.kind === "single" && entry.callerSessionId === callerSessionId);
                reject(new Error("Callee did not connect within timeout"));
            }, BRIDGE_TIMEOUT);

            addPendingEntry(calleeWallet.toLowerCase(), {
                kind: "single",
                callerSessionId,
                resolve,
                reject,
                timer,
            });
        });

        const callPayload = JSON.stringify({
            type: "call-invite",
            from: callerEns,
            to: calleeEns,
            sessionId: callerSessionId,
        });
        await sendNotification(callerEns, calleeEns, callPayload, notiTypeCall);
        const calleeSessionId = await bridgePromise;
        startWebRtcBridge(callerSessionId, calleeSessionId);
    }

    function dropRingGroupTracking(group) {
        if (!group) return;
        for (const sid of group.legsBySessionId.keys()) {
            sessionToRingGroup.delete(sid);
        }
        ringGroups.delete(group.groupId);
    }

    function clearRingGroupTimeout(group) {
        if (!group || !group.timeoutHandle) return;
        clearTimeout(group.timeoutHandle);
        group.timeoutHandle = null;
    }

    function closeLoserLegs(group, winnerSessionId) {
        if (!group) return;
        for (const [sid, leg] of group.legsBySessionId.entries()) {
            if (sid === winnerSessionId) continue;
            if (leg.state === "lost" || leg.state === "timed_out") continue;
            leg.state = "lost";
            closeSessionNow(sid, "multiring-loser");
        }
    }

    async function createLegOffer(group, leg, callerEns, callerDisplayFrom) {
        const legSession = createSession(
            leg.sessionId,
            `mr-leg-${group.groupId}`,
            `mr-target-${leg.sessionId}`,
        );
        legSession.multiRingGroupId = group.groupId;
        legSession.multiRingLeg = true;
        legSession.multiRingRole = "callee-leg";
        legSession.multiRingCallerEns = callerEns;
        legSession.multiRingCallerDisplay = callerDisplayFrom || callerEns;
        legSession.multiRingTargetEns = leg.ensName;

        const pc = createPeerConnection(leg.sessionId);
        if (typeof pc.createDataChannel === "function") {
            try { pc.createDataChannel("chat"); } catch (_) {}
        }
        legSession.localAudioTrack = new MediaStreamTrack({ kind: "audio" });
        pc.addTrack(legSession.localAudioTrack);
        legSession.iceCandidates = [];

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForIceGathering(pc);

        const gatheredCandidates = formatIceCandidates(legSession).filter((c) => {
            const cand = String(c?.candidate || "").toLowerCase();
            return !cand.includes(" tcp ");
        });
        const srflxAndRelay = gatheredCandidates.filter((c) => {
            const cand = String(c?.candidate || "");
            return cand.includes("typ srflx") || cand.includes("typ relay");
        });
        const candidatesToEmbed = srflxAndRelay.length > 0 ? srflxAndRelay : gatheredCandidates;
        const relayCandidates = getRelayCandidates(gatheredCandidates);
        const offerSdp = embedCandidatesInSdp(offer.sdp, candidatesToEmbed);

        const callPayload = JSON.stringify({
            type: "offer",
            from: callerDisplayFrom || callerEns,
            to: leg.ensName,
            sessionId: leg.sessionId,
            sdp: offerSdp,
            candidates: relayCandidates,
            isCall: true,
            multiRingGroupId: group.groupId,
        });

        leg.state = "invited";
        await sendNotification(callerEns, leg.ensName, callPayload, notiTypeCall);
        logger.log(
            `[MR:${group.groupId}] leg invited sessionId=${leg.sessionId} to=${leg.ensName}`,
        );
    }

    async function notifyAndBridgeMulti(callerSessionId, destinations) {
        const callerSession = sessions.get(callerSessionId);
        if (!callerSession) throw new Error("Caller session not found");

        const targets = Array.isArray(destinations) ? destinations : [];
        if (targets.length === 0) throw new Error("No multiring destinations provided");

        const groupId = newRingGroupId();
        const callerEns = callerSession.callerEns;
        const callerNumberLabel = getCallerNumberLabel(callerEns);
        const group = {
            groupId,
            callerSessionId,
            winnerSessionId: null,
            closed: false,
            legsBySessionId: new Map(),
            timeoutHandle: null,
            resolve: null,
            reject: null,
        };

        const winnerPromise = new Promise((resolve, reject) => {
            group.resolve = resolve;
            group.reject = reject;
        });

        group.timeoutHandle = setTimeout(() => {
            if (group.closed) return;
            group.closed = true;
            for (const leg of group.legsBySessionId.values()) {
                leg.state = leg.state === "won" ? "won" : "timed_out";
                closeSessionNow(leg.sessionId, "multiring-timeout");
            }
            dropRingGroupTracking(group);
            logger.log(`[MR:${group.groupId}] timeout with no winner`);
            group.reject(new Error("No multiring callee answered within timeout"));
        }, 60000);

        ringGroups.set(groupId, group);
        logger.log(`[MR:${group.groupId}] created callerSessionId=${callerSessionId}`);

        let legIndex = 0;
        for (const destination of targets) {
            const calleeWallet = destination.wallet;
            const calleeEns = destination.ensName || calleeWallet;
            if (!calleeWallet || !calleeEns) continue;
            legIndex += 1;
            const childSessionId = `${groupId}-leg${legIndex}`;
            const leg = {
                sessionId: childSessionId,
                walletKey: String(calleeWallet).toLowerCase(),
                ensName: calleeEns,
                state: "new",
            };
            group.legsBySessionId.set(childSessionId, leg);
            sessionToRingGroup.set(childSessionId, groupId);
            await createLegOffer(group, leg, callerEns, callerNumberLabel);
        }

        if (group.legsBySessionId.size === 0) {
            group.closed = true;
            clearRingGroupTimeout(group);
            dropRingGroupTracking(group);
            throw new Error("Multiring configured but no valid legs were created");
        }

        const winnerSessionId = await winnerPromise;
        return winnerSessionId;
    }

    async function commitWinnerFromVerifiedAnswer(sessionId, answerPayload) {
        const groupId = sessionToRingGroup.get(sessionId);
        if (!groupId) return { handled: false };
        const group = ringGroups.get(groupId);
        if (!group) return { handled: false };
        const leg = group.legsBySessionId.get(sessionId);
        if (!leg) return { handled: false };

        if (group.winnerSessionId && group.winnerSessionId !== sessionId) {
            leg.state = "lost";
            closeSessionNow(sessionId, "multiring-loser-answer");
            logger.log(`[MR:${group.groupId}] late loser answer sessionId=${sessionId}`);
            return { handled: true, won: false, winnerSessionId: group.winnerSessionId };
        }
        if (group.winnerSessionId === sessionId) {
            return { handled: true, won: true, winnerSessionId: sessionId };
        }

        group.winnerSessionId = sessionId;
        group.closed = true;
        leg.state = "answer_received";
        clearRingGroupTimeout(group);
        closeLoserLegs(group, sessionId);
        logger.log(`[MR:${group.groupId}] winner locked sessionId=${sessionId}`);

        try {
            await applyInboundAnswer(sessionId, answerPayload?.sdp, answerPayload?.candidates || []);
            leg.state = "answer_applied";
            startWebRtcBridge(group.callerSessionId, sessionId);
            leg.state = "won";
            logger.log(`[MR:${group.groupId}] bridge started winnerSessionId=${sessionId}`);
            group.resolve(sessionId);
            dropRingGroupTracking(group);
            return { handled: true, won: true, winnerSessionId: sessionId };
        } catch (err) {
            logger.error(`[MR:${group.groupId}] winner answer apply failed: ${err.message}`);
            closeSessionNow(sessionId, "multiring-winner-answer-failed");
            for (const loserLeg of group.legsBySessionId.values()) {
                if (loserLeg.sessionId === sessionId) continue;
                closeSessionNow(loserLeg.sessionId, "multiring-abort");
            }
            dropRingGroupTracking(group);
            group.reject(err);
            return { handled: true, won: false, reason: "winner-answer-apply-failed" };
        }
    }

    function startBridgeRtp(callerSessionId, calleeSessionId) {
        const callerSession = sessions.get(callerSessionId);
        const calleeSession = sessions.get(calleeSessionId);
        if (!callerSession || !calleeSession) return;

        callerSession.bridgedWith = calleeSessionId;
        calleeSession.bridgedWith = callerSessionId;
        callerSession.mediaRelayActive = true;
        calleeSession.mediaRelayActive = true;

        let callerPipeActive = false;
        let calleePipeActive = false;
        let callerSourceNotified = false;
        let calleeSourceNotified = false;

        function wireCallerToCallee() {
            if (callerPipeActive) return;
            const track = callerSession.remoteTracks.find(t => t.kind === "audio");
            if (!track || !calleeSession.localAudioTrack) return;
            callerPipeActive = true;
            track.onReceiveRtp.subscribe((rtp) => {
                if (callerSession.mediaRelayActive) {
                    if (!calleeSourceNotified) {
                        calleeSourceNotified = true;
                        calleeSession.localAudioTrack.onSourceChanged.execute({
                            sequenceNumber: rtp.header.sequenceNumber,
                            timestamp: rtp.header.timestamp,
                        });
                    }
                    calleeSession.localAudioTrack.writeRtp(rtp);
                }
            });
        }

        function wireCalleeToCaller() {
            if (calleePipeActive) return;
            const track = calleeSession.remoteTracks.find(t => t.kind === "audio");
            if (!track || !callerSession.localAudioTrack) return;
            calleePipeActive = true;
            track.onReceiveRtp.subscribe((rtp) => {
                if (callerSession.mediaRelayActive) {
                    if (!callerSourceNotified) {
                        callerSourceNotified = true;
                        callerSession.localAudioTrack.onSourceChanged.execute({
                            sequenceNumber: rtp.header.sequenceNumber,
                            timestamp: rtp.header.timestamp,
                        });
                    }
                    callerSession.localAudioTrack.writeRtp(rtp);
                }
            });
        }

        wireCallerToCallee();
        wireCalleeToCaller();

        if (callerSession.peerConnection) {
            callerSession.peerConnection.onTrack.subscribe((track) => {
                if (track.kind === "audio") {
                    callerSession.remoteTracks.push(track);
                    wireCallerToCallee();
                }
            });
        }
        if (calleeSession.peerConnection) {
            calleeSession.peerConnection.onTrack.subscribe((track) => {
                if (track.kind === "audio") {
                    calleeSession.remoteTracks.push(track);
                    wireCalleeToCaller();
                }
            });
        }
        logger.log(`[Bridge] WebRTC bridge initiated between ${callerSessionId} and ${calleeSessionId}`);
    }

    function checkPendingBridge(sessionId, walletAddress) {
        if (!walletAddress) return false;
        const key = walletAddress.toLowerCase();
        const list = getPendingList(key);
        if (!list.length) return false;

        const nextList = [];
        let handled = false;
        for (const pending of list) {
            if (pending.kind === "single") {
                if (handled) {
                    nextList.push(pending);
                    continue;
                }
                clearTimeout(pending.timer);
                pending.resolve(sessionId);
                handled = true;
                continue;
            }

            if (pending.kind === "multi") {
                // Multi-ring no longer uses wallet-join pending entries.
                continue;
            }

            nextList.push(pending);
        }

        setPendingList(key, nextList);
        return handled;
    }

    function checkPendingInboundCall(sessionId, walletAddress) {
        if (!walletAddress) return false;
        const key = walletAddress.toLowerCase();
        const pending = pendingInboundCalls.get(key);
        if (!pending) return false;
        clearTimeout(pending.timer);
        pendingInboundCalls.delete(key);
        const session = sessions.get(sessionId);
        if (!session) return false;
        session.inboundCall = {
            fromNumber: pending.fromNumber,
            toNumber: pending.toNumber,
            callId: pending.callId,
        };
        sendDataChannelMessage(sessionId, {
            msgType: "call",
            action: "incoming",
            from: pending.fromNumber,
            to: pending.toNumber,
        });
        return true;
    }

    async function handleIceRestart(sessionId, payload) {
        const session = sessions.get(sessionId);
        if (!session || !session.peerConnection) {
            throw new Error("Session or PeerConnection not found for ICE restart");
        }
        const pc = session.peerConnection;
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp, "offer"));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendDataChannelMessage(sessionId, {
            msgType: "signaling",
            payload: {
                type: "answer",
                from: session.toIdentity,
                to: session.callerEns,
                sessionId,
                sdp: answer.sdp,
            },
        });
    }

    return {
        notifyAndBridge,
        notifyAndBridgeMulti,
        commitWinnerFromVerifiedAnswer,
        startBridgeRtp,
        checkPendingBridge,
        checkPendingInboundCall,
        handleIceRestart,
    };
}

module.exports = {
    createBridgeApi,
};
