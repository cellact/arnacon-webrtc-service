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
    RTCSessionDescription,
    logger = console,
}) {
    const ringGroups = new Map();
    const sessionToRingGroup = new Map();
    const pendingMultiBridgeStarts = new Map();
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
        if (Array.isArray(session._bridgeDisposers)) {
            for (const dispose of session._bridgeDisposers) {
                try { dispose(); } catch (_) {}
            }
            session._bridgeDisposers = [];
        }
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

    function clearRingGroupTimeout(group) {
        if (!group || !group.timeoutHandle) return;
        clearTimeout(group.timeoutHandle);
        group.timeoutHandle = null;
    }

    function clearRingGroupPendingEntries(group) {
        if (!group) return;
        for (const walletKey of group.pendingWallets) {
            removePendingEntries(walletKey, (entry) => entry.kind === "multi" && entry.groupId === group.groupId);
        }
    }

    function dropRingGroupTracking(group) {
        if (!group) return;
        for (const sid of group.legSessionIds) {
            sessionToRingGroup.delete(sid);
        }
        ringGroups.delete(group.groupId);
    }

    function markConnectedSession(group, sessionId) {
        if (!group) return;
        group.connectedSessions.add(sessionId);
        sessionToRingGroup.set(sessionId, group.groupId);
    }

    async function createMultiringLegOffer(group, callerSession, callerNumberLabel, destination, legIndex) {
        const calleeWallet = destination.wallet;
        const calleeEns = destination.ensName || calleeWallet;
        if (!calleeWallet || !calleeEns) return null;

        const walletKey = String(calleeWallet).toLowerCase();
        const legSessionId = `${group.groupId}-leg${legIndex}`;
        try {
            const legSession = createSession(legSessionId, callerSession.callerEns, calleeEns);
            legSession.isGatewayCaller = true;
            legSession.walletAddress = walletKey;
            legSession.multiRingGroupId = group.groupId;
            legSession.multiRingLeg = true;
            legSession.serviceId = callerSession.serviceId || null;

            const pc = createPeerConnection(legSessionId);
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

            group.pendingWallets.add(walletKey);
            group.legSessionIds.add(legSessionId);
            sessionToRingGroup.set(legSessionId, group.groupId);
            addPendingEntry(walletKey, {
                kind: "multi",
                groupId: group.groupId,
                callerSessionId: group.callerSessionId,
                walletKey,
                ensName: calleeEns,
                legSessionId,
            });

            const sourceOffer = callerSession.lastRingOfferPayload || null;
            const callPayload = JSON.stringify({
                type: "offer",
                from: callerNumberLabel || callerSession.callerEns,
                to: calleeEns,
                sessionId: legSessionId,
                label: callerNumberLabel || undefined,
                sdp: offerSdp,
                candidates: relayCandidates,
                callNonce: sourceOffer?.callNonce || null,
                isCall: true,
                multiRingGroupId: group.groupId,
            });
            await sendNotification(callerSession.callerEns, calleeEns, callPayload, notiTypeCall);
            logger.log(`[MR:${group.groupId}] leg invited sessionId=${legSessionId} to=${calleeEns}`);
            return legSessionId;
        } catch (err) {
            closeSessionNow(legSessionId, "mr-leg-offer-failed");
            group.legSessionIds.delete(legSessionId);
            sessionToRingGroup.delete(legSessionId);
            removePendingEntries(walletKey, (entry) => entry.kind === "multi" && entry.groupId === group.groupId && entry.legSessionId === legSessionId);
            if (!hasPendingEntries(walletKey, (entry) => entry.kind === "multi" && entry.groupId === group.groupId)) {
                group.pendingWallets.delete(walletKey);
            }
            throw err;
        }
    }

    function commitReadyWinner(group, winnerSessionId) {
        if (!group) return { handled: false };
        if (group.winnerSessionId && group.winnerSessionId !== winnerSessionId) {
            closeSessionNow(winnerSessionId, "mr-loser-late-ready");
            return { handled: true, won: false, winnerSessionId: group.winnerSessionId };
        }
        if (group.winnerSessionId === winnerSessionId) {
            return { handled: true, won: true, winnerSessionId };
        }

        group.winnerSessionId = winnerSessionId;
        group.closed = true;
        clearRingGroupTimeout(group);
        clearRingGroupPendingEntries(group);

        for (const sid of group.legSessionIds) {
            if (sid === winnerSessionId) continue;
            closeSessionNow(sid, "mr-loser-winner-locked");
        }

        // Do not start media bridge here for multiring.
        // callFlow will start it explicitly after sending the caller's ANSWER.
        pendingMultiBridgeStarts.set(group.callerSessionId, winnerSessionId);
        logger.log(`[MR:${group.groupId}] winner locked from ready-session sessionId=${winnerSessionId}`);
        group.resolve(winnerSessionId);
        dropRingGroupTracking(group);
        return { handled: true, won: true, winnerSessionId };
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
            pendingWallets: new Set(),
            legSessionIds: new Set(),
            connectedSessions: new Set(),
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
            clearRingGroupPendingEntries(group);
            for (const sid of group.legSessionIds) {
                closeSessionNow(sid, "mr-timeout");
            }
            dropRingGroupTracking(group);
            logger.log(`[MR:${group.groupId}] timeout with no winner`);
            group.reject(new Error("No multiring callee answered within timeout"));
        }, 60000);

        ringGroups.set(groupId, group);
        logger.log(`[MR:${group.groupId}] created callerSessionId=${callerSessionId}`);

        let legIndex = 0;
        for (const destination of targets) {
            legIndex += 1;
            try {
                await createMultiringLegOffer(group, callerSession, callerNumberLabel, destination, legIndex);
            } catch (err) {
                logger.error(`[MR:${group.groupId}] failed leg invite #${legIndex}: ${err.message}`);
            }
        }

        if (group.pendingWallets.size === 0) {
            group.closed = true;
            clearRingGroupTimeout(group);
            dropRingGroupTracking(group);
            throw new Error("Multiring configured but no valid legs were created");
        }

        const winnerSessionId = await winnerPromise;
        return winnerSessionId;
    }

    function startBridgeRtp(callerSessionId, calleeSessionId) {
        const callerSession = sessions.get(callerSessionId);
        const calleeSession = sessions.get(calleeSessionId);
        if (!callerSession || !calleeSession) return;

        callerSession.bridgedWith = calleeSessionId;
        calleeSession.bridgedWith = callerSessionId;
        callerSession.mediaRelayActive = true;
        calleeSession.mediaRelayActive = true;
        let callerSourceNotified = false;
        let calleeSourceNotified = false;
        let c2wSub = null;
        let w2cSub = null;
        let cTrackSub = null;
        let wTrackSub = null;
        let c2wPackets = 0;
        let w2cPackets = 0;
        let statsTimer = null;

        function unsubscribe(sub) {
            if (!sub) return null;
            const fn = typeof sub.unSubscribe === "function" ? sub.unSubscribe : null;
            if (fn) {
                try { fn(); } catch (_) {}
            }
            return null;
        }

        function rebindCallerToCallee(track) {
            if (!track || track.kind !== "audio" || !calleeSession.localAudioTrack) return;
            c2wSub = unsubscribe(c2wSub);
            const sub = track.onReceiveRtp.subscribe((rtp) => {
                if (!callerSession.mediaRelayActive || !calleeSession.mediaRelayActive) return;
                c2wPackets += 1;
                if (!calleeSourceNotified && calleeSession.localAudioTrack && rtp?.header) {
                    calleeSourceNotified = true;
                    calleeSession.localAudioTrack.onSourceChanged.execute({
                        sequenceNumber: rtp.header.sequenceNumber,
                        timestamp: rtp.header.timestamp,
                    });
                }
                calleeSession.localAudioTrack.writeRtp(rtp);
            });
            c2wSub = sub || null;
        }

        function rebindCalleeToCaller(track) {
            if (!track || track.kind !== "audio" || !callerSession.localAudioTrack) return;
            w2cSub = unsubscribe(w2cSub);
            const sub = track.onReceiveRtp.subscribe((rtp) => {
                if (!callerSession.mediaRelayActive || !calleeSession.mediaRelayActive) return;
                w2cPackets += 1;
                if (!callerSourceNotified && callerSession.localAudioTrack && rtp?.header) {
                    callerSourceNotified = true;
                    callerSession.localAudioTrack.onSourceChanged.execute({
                        sequenceNumber: rtp.header.sequenceNumber,
                        timestamp: rtp.header.timestamp,
                    });
                }
                callerSession.localAudioTrack.writeRtp(rtp);
            });
            w2cSub = sub || null;
        }

        function getReceiverAudioTracks(session) {
            const out = [];
            const seen = new Set();
            if (session?.peerConnection?.getTransceivers) {
                for (const tr of session.peerConnection.getTransceivers()) {
                    if (tr?.kind !== "audio" || !tr.receiver?.tracks) continue;
                    for (const t of tr.receiver.tracks) {
                        if (!t || t.kind !== "audio") continue;
                        if (seen.has(t)) continue;
                        seen.add(t);
                        out.push(t);
                    }
                }
            }
            for (const t of session?.remoteTracks || []) {
                if (!t || t.kind !== "audio") continue;
                if (seen.has(t)) continue;
                seen.add(t);
                out.push(t);
            }
            return out;
        }

        const callerTrack = getReceiverAudioTracks(callerSession)[0];
        if (callerTrack) rebindCallerToCallee(callerTrack);
        const calleeTrack = getReceiverAudioTracks(calleeSession)[0];
        if (calleeTrack) rebindCalleeToCaller(calleeTrack);

        if (callerSession.peerConnection) {
            const sub = callerSession.peerConnection.onTrack.subscribe((track) => {
                if (track.kind !== "audio") return;
                if (!callerSession.remoteTracks.includes(track)) callerSession.remoteTracks.push(track);
                rebindCallerToCallee(track);
            });
            cTrackSub = sub || null;
        }
        if (calleeSession.peerConnection) {
            const sub = calleeSession.peerConnection.onTrack.subscribe((track) => {
                if (track.kind !== "audio") return;
                if (!calleeSession.remoteTracks.includes(track)) calleeSession.remoteTracks.push(track);
                rebindCalleeToCaller(track);
            });
            wTrackSub = sub || null;
        }

        const callerDisposers = callerSession._bridgeDisposers || [];
        const calleeDisposers = calleeSession._bridgeDisposers || [];
        callerDisposers.push(() => { c2wSub = unsubscribe(c2wSub); });
        callerDisposers.push(() => { cTrackSub = unsubscribe(cTrackSub); });
        callerDisposers.push(() => {
            if (statsTimer) {
                clearInterval(statsTimer);
                statsTimer = null;
            }
        });
        calleeDisposers.push(() => { w2cSub = unsubscribe(w2cSub); });
        calleeDisposers.push(() => { wTrackSub = unsubscribe(wTrackSub); });
        callerSession._bridgeDisposers = callerDisposers;
        calleeSession._bridgeDisposers = calleeDisposers;
        statsTimer = setInterval(() => {
            if (!callerSession.mediaRelayActive || !calleeSession.mediaRelayActive) return;
            logger.log(`[Bridge][${callerSessionId}<->${calleeSessionId}] rtp c2w=${c2wPackets} w2c=${w2cPackets}`);
        }, 2000);
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
                if (pending.legSessionId && pending.legSessionId !== sessionId) {
                    nextList.push(pending);
                    continue;
                }
                const group = ringGroups.get(pending.groupId);
                if (!group || group.closed) {
                    continue;
                }
                if (group.winnerSessionId && group.winnerSessionId !== sessionId) {
                    closeSessionNow(sessionId, "mr-loser-late-ready");
                    handled = true;
                    continue;
                }
                markConnectedSession(group, sessionId);
                const winner = commitReadyWinner(group, sessionId);
                handled = winner.handled || handled;
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

    function startPendingMultiBridge(callerSessionId) {
        if (!callerSessionId) return false;
        const winnerSessionId = pendingMultiBridgeStarts.get(callerSessionId);
        if (!winnerSessionId) return false;
        pendingMultiBridgeStarts.delete(callerSessionId);
        startWebRtcBridge(callerSessionId, winnerSessionId);
        logger.log(`[MR] bridge started after answer callerSessionId=${callerSessionId} winnerSessionId=${winnerSessionId}`);
        return true;
    }

    return {
        notifyAndBridge,
        notifyAndBridgeMulti,
        startBridgeRtp,
        startPendingMultiBridge,
        checkPendingBridge,
        checkPendingInboundCall,
        handleIceRestart,
    };
}

module.exports = {
    createBridgeApi,
};
