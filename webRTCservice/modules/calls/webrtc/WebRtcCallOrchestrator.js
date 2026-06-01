const { MediaGraphFactory } = require("../../media/MediaGraphFactory");
const { WebRtcBridgeCoordinator } = require("../WebRtcBridgeCoordinator");
const { PendingBridgeRegistry } = require("./PendingBridgeRegistry");
const { WebRtcOutboundLegFactory } = require("./WebRtcOutboundLegFactory");
const { MultiringCoordinator } = require("./MultiringCoordinator");

class WebRtcCallOrchestrator {
    constructor({
        sessions,
        pendingBridges,
        pendingInboundCalls,
        createPeerConnection,
        sendNotification,
        sendDataChannelMessage,
        destroySession,
        notiTypeCall,
        MediaStreamTrack,
        waitForIceGathering,
        formatIceCandidates,
        getRelayCandidates,
        embedCandidatesInSdp,
        RTCSessionDescription,
        onDataChannelOpen = null,
        onDataChannelMessage = null,
        onCallEvent = null,
        logger = console,
    } = {}) {
        Object.assign(this, {
            sessions,
            pendingInboundCalls,
            sendNotification,
            sendDataChannelMessage,
            destroySession,
            onCallEvent,
            notiTypeCall,
            RTCSessionDescription,
            logger,
        });
        const mediaGraphFactory = new MediaGraphFactory({
            sessions,
            MediaStreamTrack,
            logger,
        });
        this.webrtcBridgeCoordinator = new WebRtcBridgeCoordinator({
            sessions,
            mediaGraphFactory,
            logger,
        });
        this.pendingBridgeRegistry = new PendingBridgeRegistry({ pendingBridges });
        this.outboundLegFactory = new WebRtcOutboundLegFactory({
            sessions,
            createPeerConnection,
            MediaStreamTrack,
            waitForIceGathering,
            formatIceCandidates,
            getRelayCandidates,
            embedCandidatesInSdp,
            onDataChannelOpen,
            onDataChannelMessage,
            logger,
        });
        this.multiringCoordinator = new MultiringCoordinator({
            sessions,
            pendingBridgeRegistry: this.pendingBridgeRegistry,
            outboundLegFactory: this.outboundLegFactory,
            sendNotification,
            sendDataChannelMessage,
            destroySession,
            onCallEvent,
            startWebRtcBridge: (...args) => this.startBridgeRtp(...args),
            notiTypeCall,
            logger,
        });
    }

    closeSessionNow(sessionId, reason = "webrtc-cleanup") {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        try {
            this.sendDataChannelMessage(sessionId, { msgType: "call", action: "end", reason });
        } catch (_) {}
        this.onCallEvent(sessionId, {
            type: "call-cancel-requested",
            source: "webrtc",
            route: "webrtc",
            reason,
            notifyClient: false,
            propagateLinkedSession: false,
        }).catch(() => {});
    }

    waitForWebrtcPickup(callerSessionId, legSessionId, walletKey, timeoutReason = "webrtc-pickup-timeout") {
        const BRIDGE_TIMEOUT = 60000;
        let timer = null;
        let rejectPickup = null;
        const promise = new Promise((resolve, reject) => {
            rejectPickup = reject;
            timer = setTimeout(() => {
                this.pendingBridgeRegistry.remove(walletKey, (entry) => entry.kind === "webrtc" && entry.callerSessionId === callerSessionId);
                this.closeSessionNow(legSessionId, timeoutReason);
                reject(new Error("Callee did not connect within timeout"));
            }, BRIDGE_TIMEOUT);

            this.pendingBridgeRegistry.add(walletKey, {
                kind: "webrtc",
                callerSessionId,
                legSessionId,
                resolve,
                reject,
                timer,
            });
        });
        return {
            promise,
            cancel: (reason = "webrtc-pickup-cancelled") => {
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
                this.pendingBridgeRegistry.remove(walletKey, (entry) => entry.kind === "webrtc" && entry.legSessionId === legSessionId);
                if (typeof rejectPickup === "function") {
                    rejectPickup(new Error(reason));
                }
            },
        };
    }

    async notifyAndBridge(callerSessionId, destination) {
        const {
            legSession,
            legSessionId,
            walletKey,
            calleeEns,
            callerEns,
            callPayload,
        } = await this.outboundLegFactory.create(callerSessionId, destination, { kind: "webrtc" });

        const pickup = this.waitForWebrtcPickup(callerSessionId, legSessionId, walletKey);
        try {
            legSession.lastNotificationResult = await this.sendNotification(callerEns, calleeEns, callPayload, this.notiTypeCall);
        } catch (err) {
            pickup.promise.catch(() => {});
            pickup.cancel("webrtc-notification-failed");
            this.closeSessionNow(legSessionId, "webrtc-notification-failed");
            throw err;
        }
        const calleeSessionId = await pickup.promise;
        this.startBridgeRtp(callerSessionId, calleeSessionId);
        this.logger.log(`[Bridge] WebRTC callee connected callerSessionId=${callerSessionId} calleeSessionId=${calleeSessionId}`);
        return calleeSessionId;
    }

    notifyAndBridgeMulti(callerSessionId, destinations) {
        return this.multiringCoordinator.notifyAndBridgeMulti(callerSessionId, destinations);
    }

    startBridgeRtp(callerSessionId, calleeSessionId) {
        const callerSession = this.sessions.get(callerSessionId);
        const calleeSession = callerSessionId === calleeSessionId
            ? callerSession?.outboundWebrtc
            : this.sessions.get(calleeSessionId) || callerSession?.outboundWebrtcLegs?.get(calleeSessionId);
        if (!callerSession || !calleeSession) return;
        this.webrtcBridgeCoordinator.connect(callerSessionId, calleeSessionId).catch((err) => {
            this.logger.error(`[Bridge][${callerSessionId}<->${calleeSessionId}] media bridge failed: ${err.message}`);
        });
    }

    commitWebrtcBridgePickup(sessionId) {
        if (!sessionId) return { handled: false };
        for (const [walletKey, list] of this.pendingBridgeRegistry.entries()) {
            const entries = Array.isArray(list) ? list : [list];
            const nextList = [];
            let matched = null;
            for (const pending of entries) {
                if (pending.kind === "webrtc" && pending.legSessionId === sessionId) {
                    matched = pending;
                    continue;
                }
                nextList.push(pending);
            }
            if (!matched) continue;
            clearTimeout(matched.timer);
            this.pendingBridgeRegistry.setList(walletKey, nextList);
            matched.resolve(sessionId);
            this.logger.log(`[Bridge] WebRTC pickup confirmed sessionId=${sessionId}`);
            return { handled: true, sessionId };
        }
        return { handled: false };
    }

    checkPendingBridge(sessionId, walletAddress) {
        if (!walletAddress) return false;
        const key = walletAddress.toLowerCase();
        const list = this.pendingBridgeRegistry.getList(key);
        if (!list.length) return false;

        const nextList = [];
        let handled = false;
        for (const pending of list) {
            if (pending.kind === "webrtc") {
                if (handled) {
                    nextList.push(pending);
                    continue;
                }
                if (pending.legSessionId && pending.legSessionId !== sessionId) {
                    nextList.push(pending);
                    continue;
                }
                const session = this.sessions.get(sessionId);
                if (session) session.outboundWebrtcTransportReady = true;
                nextList.push(pending);
                handled = true;
                continue;
            }

            if (pending.kind === "multi") {
                const result = this.multiringCoordinator.checkPendingBridge(sessionId, pending);
                if (result.keep) nextList.push(pending);
                if (result.handled) handled = true;
                continue;
            }

            nextList.push(pending);
        }

        this.pendingBridgeRegistry.setList(key, nextList);
        return handled;
    }

    checkPendingInboundCall(sessionId, walletAddress) {
        if (!walletAddress) return false;
        const key = walletAddress.toLowerCase();
        const pending = this.pendingInboundCalls.get(key);
        if (!pending) return false;
        clearTimeout(pending.timer);
        this.pendingInboundCalls.delete(key);
        const session = this.sessions.get(sessionId);
        if (!session) return false;
        session.inboundCall = {
            fromNumber: pending.fromNumber,
            toNumber: pending.toNumber,
            callId: pending.callId,
        };
        this.sendDataChannelMessage(sessionId, {
            msgType: "call",
            action: "incoming",
            from: pending.fromNumber,
            to: pending.toNumber,
        });
        return true;
    }

    async handleIceRestart(sessionId, payload) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.peerConnection) {
            throw new Error("Session or PeerConnection not found for ICE restart");
        }
        const pc = session.peerConnection;
        await pc.setRemoteDescription(new this.RTCSessionDescription(payload.sdp, "offer"));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.sendDataChannelMessage(sessionId, {
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

    startPendingMultiBridge(callerSessionId) {
        return this.multiringCoordinator.startPendingBridge(callerSessionId);
    }

    commitWinnerFromAnswer(sessionId) {
        return this.multiringCoordinator.commitWinnerFromAnswer(sessionId);
    }

    commitWinnerFromDataChannelAnswer(sessionId) {
        return this.multiringCoordinator.commitWinnerFromDataChannelAnswer(sessionId);
    }
}

module.exports = {
    WebRtcCallOrchestrator,
};
