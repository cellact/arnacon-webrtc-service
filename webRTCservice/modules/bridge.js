"use strict";

function createBridgeApi({
    sessions,
    pendingBridges,
    pendingInboundCalls,
    sendNotification,
    sendDataChannelMessage,
    startWebRtcBridge,
    notiTypeCall,
    RTCSessionDescription,
    logger = console,
}) {
    async function notifyAndBridge(callerSessionId, destination) {
        const callerSession = sessions.get(callerSessionId);
        if (!callerSession) throw new Error("Caller session not found");

        const calleeWallet = destination.wallet;
        const calleeEns = destination.ensName || calleeWallet;
        const callerEns = callerSession.callerEns;

        const BRIDGE_TIMEOUT = 60000;
        const bridgePromise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pendingBridges.delete(calleeWallet.toLowerCase());
                reject(new Error("Callee did not connect within timeout"));
            }, BRIDGE_TIMEOUT);

            pendingBridges.set(calleeWallet.toLowerCase(), {
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
        const pending = pendingBridges.get(key);
        if (!pending) return false;
        clearTimeout(pending.timer);
        pendingBridges.delete(key);
        pending.resolve(sessionId);
        return true;
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
        startBridgeRtp,
        checkPendingBridge,
        checkPendingInboundCall,
        handleIceRestart,
    };
}

module.exports = {
    createBridgeApi,
};
