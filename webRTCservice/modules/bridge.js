"use strict";

function createBridgeApi({
    sessions,
    pendingBridges,
    pendingInboundCalls,
    sendNotification,
    sendDataChannelMessage,
    startWebRtcBridge,
    destroySession,
    notiTypeCall,
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

    async function notifyAndBridgeMulti(callerSessionId, destinations) {
        const callerSession = sessions.get(callerSessionId);
        if (!callerSession) throw new Error("Caller session not found");
        const sourceOffer = callerSession.lastRingOfferPayload || null;
        if (!sourceOffer || !sourceOffer.sdp) {
            throw new Error("Multiring requires a valid source offer payload with SDP");
        }

        const targets = Array.isArray(destinations) ? destinations : [];
        if (targets.length === 0) throw new Error("No multiring destinations provided");

        const groupId = newRingGroupId();
        const callerEns = callerSession.callerEns;
        const callerNumberLabel = getCallerNumberLabel(callerEns);
        const timeoutMs = 60000;
        const group = {
            groupId,
            callerSessionId,
            winnerSessionId: null,
            closed: false,
            pendingWallets: new Set(),
            candidateSessionsByWallet: new Map(),
            candidateSessionsById: new Set(),
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
            for (const walletKey of group.pendingWallets) {
                removePendingEntries(walletKey, (entry) => entry.kind === "multi" && entry.groupId === groupId);
            }
            for (const sid of group.candidateSessionsById) {
                closeSessionNow(sid, "multiring-timeout");
                sessionToRingGroup.delete(sid);
            }
            ringGroups.delete(groupId);
            group.reject(new Error("No multiring callee answered within timeout"));
        }, timeoutMs);

        ringGroups.set(groupId, group);

        let legIndex = 0;
        for (const destination of targets) {
            const calleeWallet = destination.wallet;
            const calleeEns = destination.ensName || calleeWallet;
            if (!calleeWallet) continue;
            legIndex += 1;
            const childSessionId = `${groupId}-leg${legIndex}`;
            const walletKey = calleeWallet.toLowerCase();
            group.pendingWallets.add(walletKey);
            addPendingEntry(walletKey, {
                kind: "multi",
                groupId,
                callerSessionId,
                childSessionId,
                walletKey,
                ensName: calleeEns,
            });

            const callPayload = JSON.stringify({
                type: "offer",
                from: callerNumberLabel || callerEns,
                to: calleeEns,
                sessionId: childSessionId,
                sdp: sourceOffer.sdp,
                candidates: Array.isArray(sourceOffer.candidates) ? sourceOffer.candidates : [],
                callNonce: sourceOffer.callNonce || null,
                isCall: true,
                multiRingGroupId: groupId,
            });
            await sendNotification(callerEns, calleeEns, callPayload, notiTypeCall);
        }

        const winnerSessionId = await winnerPromise;
        return winnerSessionId;
    }

    function registerMultiRingCandidate(groupId, walletKey, sessionId) {
        const group = ringGroups.get(groupId);
        if (!group || group.closed) {
            closeSessionNow(sessionId, "multiring-group-closed");
            return false;
        }
        if (group.winnerSessionId) {
            closeSessionNow(sessionId, "multiring-already-won");
            return false;
        }
        group.candidateSessionsByWallet.set(walletKey, sessionId);
        group.candidateSessionsById.add(sessionId);
        sessionToRingGroup.set(sessionId, groupId);
        const session = sessions.get(sessionId);
        if (session) {
            session.multiRingGroupId = groupId;
            session.multiRingWalletKey = walletKey;
        }
        return true;
    }

    function tryCommitMultiRingWinner(sessionId) {
        const groupId = sessionToRingGroup.get(sessionId);
        if (!groupId) return { handled: false };

        const group = ringGroups.get(groupId);
        if (!group) return { handled: false };

        if (group.winnerSessionId && group.winnerSessionId !== sessionId) {
            closeSessionNow(sessionId, "multiring-loser-answer");
            sessionToRingGroup.delete(sessionId);
            return { handled: true, won: false, winnerSessionId: group.winnerSessionId };
        }

        if (group.winnerSessionId === sessionId) {
            return { handled: true, won: true, winnerSessionId: sessionId };
        }

        group.winnerSessionId = sessionId;
        group.closed = true;
        if (group.timeoutHandle) {
            clearTimeout(group.timeoutHandle);
            group.timeoutHandle = null;
        }

        for (const walletKey of group.pendingWallets) {
            removePendingEntries(walletKey, (entry) => entry.kind === "multi" && entry.groupId === groupId);
        }

        for (const sid of group.candidateSessionsById) {
            if (sid === sessionId) continue;
            closeSessionNow(sid, "multiring-loser");
            sessionToRingGroup.delete(sid);
        }
        sessionToRingGroup.delete(sessionId);

        startWebRtcBridge(group.callerSessionId, sessionId);
        group.resolve(sessionId);
        ringGroups.delete(groupId);

        return { handled: true, won: true, winnerSessionId: sessionId };
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
                if (handled) {
                    nextList.push(pending);
                    continue;
                }
                handled = registerMultiRingCandidate(pending.groupId, key, sessionId) || handled;
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
        startBridgeRtp,
        checkPendingBridge,
        tryCommitMultiRingWinner,
        checkPendingInboundCall,
        handleIceRestart,
    };
}

module.exports = {
    createBridgeApi,
};
