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

    createBridgeAttemptId(callerSessionId) {
        return `${callerSessionId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    }

    isOpenDataChannel(channel) {
        return channel && (channel.readyState === "open" || channel.readyState === "OPEN");
    }

    identityLabel(identity) {
        if (!identity || typeof identity !== "string") return identity;
        const trimmed = identity.trim();
        const atPos = trimmed.indexOf("@");
        if (atPos > 0) return trimmed.slice(0, atPos);
        const dotPos = trimmed.indexOf(".");
        if (dotPos > 0) return trimmed.slice(0, dotPos);
        return trimmed;
    }

    sameIdentity(left, right) {
        return this.identityLabel(String(left || "").toLowerCase()) ===
            this.identityLabel(String(right || "").toLowerCase());
    }

    findReusableOutboundLeg(callerSessionId, destination = {}) {
        const callerSession = this.sessions.get(callerSessionId);
        if (!callerSession) return null;

        const walletKey = String(destination.wallet || "").toLowerCase();
        const targetEns = destination.ensName || destination.wallet || "";
        const candidates = [];
        if (callerSession.outboundWebrtc) candidates.push(callerSession.outboundWebrtc);
        if (callerSession.outboundWebrtcLegs?.values) {
            for (const leg of callerSession.outboundWebrtcLegs.values()) candidates.push(leg);
        }

        return candidates.find((leg) => {
            if (!leg?.peerConnection || !this.isOpenDataChannel(leg.dataChannel)) return false;
            if (walletKey && String(leg.walletAddress || "").toLowerCase() === walletKey) return true;
            return targetEns && this.sameIdentity(leg.toIdentity, targetEns);
        }) || null;
    }

    waitForWebrtcPickup(callerSessionId, legSessionId, walletKey, attemptId, timeoutReason = "webrtc-pickup-timeout") {
        const BRIDGE_TIMEOUT = 60000;
        let timer = null;
        let rejectPickup = null;
        const promise = new Promise((resolve, reject) => {
            rejectPickup = reject;
            timer = setTimeout(() => {
                const stillCurrent = this.pendingBridgeRegistry.getList(walletKey).some((entry) =>
                    entry.kind === "webrtc" &&
                    entry.callerSessionId === callerSessionId &&
                    entry.attemptId === attemptId
                );
                if (!stillCurrent) return;
                this.pendingBridgeRegistry.remove(walletKey, (entry) =>
                    entry.kind === "webrtc" &&
                    entry.callerSessionId === callerSessionId &&
                    entry.attemptId === attemptId
                );
                this.closeSessionNow(legSessionId, timeoutReason);
                reject(new Error("Callee did not connect within timeout"));
            }, BRIDGE_TIMEOUT);

            this.pendingBridgeRegistry.add(walletKey, {
                kind: "webrtc",
                attemptId,
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
                this.pendingBridgeRegistry.remove(walletKey, (entry) =>
                    entry.kind === "webrtc" &&
                    entry.legSessionId === legSessionId &&
                    entry.attemptId === attemptId
                );
                if (typeof rejectPickup === "function") {
                    rejectPickup(new Error(reason));
                }
            },
        };
    }

    cancelPendingBridgeForSession(sessionId, reason = "webrtc-pickup-cancelled") {
        let cancelled = false;
        for (const [walletKey, rawList] of Array.from(this.pendingBridgeRegistry.entries())) {
            const list = Array.isArray(rawList) ? rawList : [rawList];
            const nextList = [];
            for (const entry of list) {
                if (entry?.callerSessionId === sessionId || entry?.legSessionId === sessionId) {
                    if (entry.timer) clearTimeout(entry.timer);
                    if (typeof entry.reject === "function") entry.reject(new Error(reason));
                    cancelled = true;
                } else {
                    nextList.push(entry);
                }
            }
            this.pendingBridgeRegistry.setList(walletKey, nextList);
        }
        return cancelled;
    }

    async tryBridgeOverExistingLeg(callerSessionId, destination, sendRingOverDataChannel) {
        const callerSession = this.sessions.get(callerSessionId);
        if (!callerSession || typeof sendRingOverDataChannel !== "function") return null;
        const legSession = this.findReusableOutboundLeg(callerSessionId, destination);
        if (!legSession) return null;

        this.cancelPendingBridgeForSession(callerSessionId, "webrtc-pickup-replaced");
        const walletKey = String(legSession.walletAddress || destination?.wallet || callerSessionId).toLowerCase();
        const bridgeAttemptId = this.createBridgeAttemptId(callerSessionId);
        callerSession.outboundWebrtc = legSession;
        callerSession.outboundLegHttpAnswered = true;
        callerSession.outboundLegRingSent = false;
        callerSession.outboundWebrtcTransportReady = true;
        legSession.bridgeAttemptId = bridgeAttemptId;
        legSession.outboundBridgeKind = legSession.outboundBridgeKind || "single";

        const pickup = this.waitForWebrtcPickup(callerSessionId, callerSessionId, walletKey, bridgeAttemptId);
        try {
            this.logger.log(`[${callerSessionId}] Reusing existing WebRTC callee leg over data channel`);
            await sendRingOverDataChannel();
            const calleeSessionId = await pickup.promise;
            if (!calleeSessionId) return null;
            this.startBridgeRtp(callerSessionId, calleeSessionId);
            this.logger.log(`[Bridge] WebRTC callee connected over existing data channel callerSessionId=${callerSessionId} calleeSessionId=${calleeSessionId}`);
            return calleeSessionId;
        } catch (err) {
            pickup.promise.catch(() => {});
            pickup.cancel(err?.message || "webrtc-existing-leg-failed");
            throw err;
        }
    }

    async notifyAndBridge(callerSessionId, destination) {
        this.cancelPendingBridgeForSession(callerSessionId, "webrtc-pickup-replaced");
        const {
            legSession,
            legSessionId,
            walletKey,
            calleeEns,
            callerEns,
            callPayload,
        } = await this.outboundLegFactory.create(callerSessionId, destination, { kind: "webrtc" });

        const bridgeAttemptId = this.createBridgeAttemptId(callerSessionId);
        legSession.bridgeAttemptId = bridgeAttemptId;
        const pickup = this.waitForWebrtcPickup(callerSessionId, legSessionId, walletKey, bridgeAttemptId);
        try {
            legSession.lastNotificationResult = await this.sendNotification(callerEns, calleeEns, callPayload, this.notiTypeCall);
        } catch (err) {
            pickup.promise.catch(() => {});
            pickup.cancel("webrtc-notification-failed");
            this.closeSessionNow(legSessionId, "webrtc-notification-failed");
            throw err;
        }
        let calleeSessionId;
        try {
            calleeSessionId = await pickup.promise;
        } catch (err) {
            const session = this.sessions.get(callerSessionId);
            if (!session || session.callEndInProgress || session.phase === "post-call" || session.phase === "cancelled") {
                this.logger.log(`[${callerSessionId}] WebRTC pickup wait cancelled after call end: ${err.message}`);
                return null;
            }
            throw err;
        }
        if (!calleeSessionId) return null;
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
