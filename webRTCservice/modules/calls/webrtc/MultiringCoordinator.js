const { identityLabel, normalizeSessionId } = require("../../runtime/CallPairRef");

const DEFAULT_INBOUND_TIMEOUT_MS = 60000;
const MAX_TARGETS = 5;

class MultiringCoordinator {
    constructor({
        sessions,
        sessionsByUser,
        stableKey,
        createSession,
        outboundLegFactory,
        sendNotification,
        applySessionAnswer,
        destroySession,
        notiTypeCall,
        timeoutMs = DEFAULT_INBOUND_TIMEOUT_MS,
        logger = console,
    } = {}) {
        if (!sessions) throw new Error("MultiringCoordinator requires sessions");
        if (!sessionsByUser) throw new Error("MultiringCoordinator requires sessionsByUser");
        if (typeof stableKey !== "function") throw new Error("MultiringCoordinator requires stableKey");
        if (typeof createSession !== "function") throw new Error("MultiringCoordinator requires createSession");
        if (!outboundLegFactory) throw new Error("MultiringCoordinator requires outboundLegFactory");
        if (typeof sendNotification !== "function") throw new Error("MultiringCoordinator requires sendNotification");
        if (typeof applySessionAnswer !== "function") throw new Error("MultiringCoordinator requires applySessionAnswer");
        if (typeof destroySession !== "function") throw new Error("MultiringCoordinator requires destroySession");
        Object.assign(this, {
            sessions,
            sessionsByUser,
            stableKey,
            createSession,
            outboundLegFactory,
            sendNotification,
            applySessionAnswer,
            destroySession,
            notiTypeCall,
            timeoutMs,
            logger,
        });
        this.groups = new Map();
        this.byHostSession = new Map();
        this.bySignalingSession = new Map();
        this.byCallNonceAndEndpoint = new Map();
        this.byPeerConnection = new Map();
        this.nextId = 1;
    }

    _newId() {
        const id = `mr-${Date.now()}-${this.nextId}`;
        this.nextId += 1;
        return id;
    }

    _wireSessionId(value) {
        return normalizeSessionId(String(value || ""));
    }

    _candidateForMeta(hostSessionId, meta = {}) {
        const group = this.byHostSession.get(hostSessionId);
        if (!group) return null;
        const wallet = String(meta.walletAddress || "").toLowerCase();
        if (wallet && group.candidates.get(wallet)) return group.candidates.get(wallet);
        const endpoint = identityLabel(String(meta.calleeIdentity || "").toLowerCase());
        if (endpoint) {
            for (const candidate of group.candidates.values()) {
                if (identityLabel(String(candidate.ensName || "").toLowerCase()) === endpoint) return candidate;
            }
        }
        const signalingId = this._wireSessionId(meta.signalingSessionId);
        if (signalingId) {
            const candidate = this.bySignalingSession.get(signalingId);
            if (candidate?.group === group) return candidate;
        }
        return null;
    }

    _candidateForOffer(offer = {}) {
        const nonceEndpointKey = this._nonceEndpointKey(offer.callNonce, offer.from);
        const byNonce = nonceEndpointKey ? this.byCallNonceAndEndpoint.get(nonceEndpointKey) : null;
        if (byNonce) return byNonce;
        const bySession = this.bySignalingSession.get(this._wireSessionId(offer.sessionId));
        if (bySession) return bySession;
        const from = identityLabel(String(offer.from || "").toLowerCase());
        if (!from) return null;
        for (const group of this.groups.values()) {
            for (const candidate of group.candidates.values()) {
                if (
                    candidate.status === "ringing"
                    && identityLabel(String(candidate.ensName || "").toLowerCase()) === from
                ) {
                    return candidate;
                }
            }
        }
        return null;
    }

    _nonceEndpointKey(callNonce, endpoint) {
        const nonce = String(callNonce || "");
        const label = identityLabel(String(endpoint || "").toLowerCase());
        return nonce && label ? `${nonce}|${label}` : "";
    }

    _trackCandidate(group, candidate) {
        group.candidates.set(candidate.walletKey, candidate);
        this.sessionsByUser.set(
            this.stableKey(candidate.ensName, group.hostSession.callerEns),
            group.hostSessionId,
        );
        this.bySignalingSession.set(this._wireSessionId(candidate.legSession.signalingSessionId), candidate);
        this.byCallNonceAndEndpoint.set(
            this._nonceEndpointKey(group.callNonce, candidate.ensName),
            candidate,
        );
        if (candidate.legSession.peerConnection) {
            this.byPeerConnection.set(candidate.legSession.peerConnection, candidate);
        }
    }

    _untrackCandidate(candidate, { preservePair = false } = {}) {
        if (!candidate) return;
        if (!preservePair) {
            const pairKey = this.stableKey(
                candidate.ensName,
                candidate.group?.hostSession?.callerEns,
            );
            if (this.sessionsByUser.get(pairKey) === candidate.group?.hostSessionId) {
                this.sessionsByUser.delete(pairKey);
            }
        }
        const signalingKey = this._wireSessionId(candidate.legSession?.signalingSessionId);
        if (this.bySignalingSession.get(signalingKey) === candidate) {
            this.bySignalingSession.delete(signalingKey);
        }
        const nonceEndpointKey = this._nonceEndpointKey(candidate.group?.callNonce, candidate.ensName);
        if (this.byCallNonceAndEndpoint.get(nonceEndpointKey) === candidate) {
            this.byCallNonceAndEndpoint.delete(nonceEndpointKey);
        }
        if (this.byPeerConnection.get(candidate.legSession?.peerConnection) === candidate) {
            this.byPeerConnection.delete(candidate.legSession.peerConnection);
        }
    }

    _sendLegMessage(candidate, message) {
        const dc = candidate?.legSession?.dataChannel;
        if (!dc || (dc.readyState !== "open" && dc.readyState !== "OPEN")) return;
        try {
            dc.send(JSON.stringify(message));
        } catch (_) {}
    }

    closeCandidate(candidate, reason = "multiring-loser") {
        if (!candidate || candidate.status === "closed") return;
        candidate.status = "closed";
        candidate.closeReason = reason;
        this._untrackCandidate(candidate);
        const group = candidate.group;
        const mapped = group.hostSession?.outboundWebrtcLegs?.get(candidate.walletKey);
        if (mapped === candidate.legSession) {
            group.hostSession.outboundWebrtcLegs.delete(candidate.walletKey);
        }
        this._sendLegMessage(candidate, { msgType: "call", action: "end", reason });
        try { candidate.legSession.dataChannel?.close(); } catch (_) {}
        try { candidate.legSession.peerConnection?.close(); } catch (_) {}
        candidate.legSession.dataChannel = null;
        candidate.legSession.peerConnection = null;
        this.logger.log("[multiring] candidate closed", {
            call: group.id,
            target: candidate.ensName,
            reason,
            routingGroupId: group.metadataGroupId,
        });
    }

    _activeCandidates(group) {
        return [...group.candidates.values()].filter((candidate) =>
            candidate.status === "ringing" || candidate.status === "winner"
        );
    }

    _finishGroup(group, { preserveWinnerPair = false } = {}) {
        if (!group || group.finished) return;
        group.finished = true;
        if (group.timer) {
            clearTimeout(group.timer);
            group.timer = null;
        }
        for (const candidate of group.candidates.values()) {
            this._untrackCandidate(candidate, {
                preservePair: preserveWinnerPair && candidate === group.winner,
            });
        }
        this.groups.delete(group.id);
        if (this.byHostSession.get(group.hostSessionId) === group) {
            this.byHostSession.delete(group.hostSessionId);
        }
    }

    _cleanupNoAnswer(group, reason = "inbound-timeout") {
        if (!group || group.finished || group.winner) return;
        for (const candidate of group.candidates.values()) this.closeCandidate(candidate, reason);
        this._finishGroup(group);
        this.destroySession(group.hostSessionId, false);
        this.logger.log("[multiring] inbound call ended without answer", {
            call: group.id,
            reason,
            routingGroupId: group.metadataGroupId,
        });
    }

    async _createCandidate(group, destination) {
        const walletKey = String(destination?.wallet || "").toLowerCase();
        const ensName = destination?.ensName || destination?.wallet;
        if (!walletKey || !ensName || group.candidates.has(walletKey)) return null;
        let legSession = null;
        try {
            const created = await this.outboundLegFactory.create(group.hostSessionId, destination, {
                kind: "multi",
            });
            legSession = created.legSession;
            const candidate = {
                group,
                walletKey,
                ensName: created.calleeEns,
                legSession,
                status: "ringing",
                httpAnswered: false,
                dataChannelOpen: false,
            };
            this._trackCandidate(group, candidate);
            // Inbound provider-plan lookup intentionally uses the callee identity
            // for both notification identities. The real PSTN caller remains in
            // the signed call payload built by WebRtcOutboundLegFactory.
            legSession.lastNotificationResult = await this.sendNotification(
                created.calleeEns,
                created.calleeEns,
                created.callPayload,
                this.notiTypeCall,
            );
            this.logger.log("[multiring] candidate invited", {
                call: group.id,
                target: created.calleeEns,
                routingGroupId: group.metadataGroupId,
            });
            return candidate;
        } catch (err) {
            const candidate = group.candidates.get(walletKey);
            if (candidate) this.closeCandidate(candidate, "multiring-invite-failed");
            else {
                try { legSession?.dataChannel?.close(); } catch (_) {}
                try { legSession?.peerConnection?.close(); } catch (_) {}
            }
            this.logger.error("[multiring] candidate invite failed", {
                call: group.id,
                target: ensName,
                error: err.message,
                routingGroupId: group.metadataGroupId,
            });
            return null;
        }
    }

    async startInbound(data, decision) {
        const targets = Array.isArray(decision?.targets)
            ? decision.targets.slice(0, MAX_TARGETS)
            : [];
        if (targets.length === 0) {
            throw Object.assign(new Error("MULTI_RING has no valid targets"), {
                statusCode: 404,
                route: "webrtc-multiring",
            });
        }
        const gatewayIdentity = String(data.from || "").replace(/^\+/, "");
        const id = this._newId();
        const hostSessionId = `${gatewayIdentity}|${id}`;
        // The eventual callee is not known until the winner is locked. Leaving the
        // target empty avoids registering a fake pair in sessionsByUser; handoff
        // binds the real winner identity.
        const hostSession = this.createSession(hostSessionId, gatewayIdentity, null);
        hostSession.serviceId = data.serviceId || null;
        hostSession.callNonce = id;
        hostSession.inboundCall = {
            fromNumber: data.from,
            toNumber: data.to,
            callId: data.callId,
        };
        hostSession.isGatewayCaller = true;
        hostSession.isMultiringHost = true;
        const group = {
            id,
            metadataGroupId: decision.groupId || null,
            ruleId: decision.ruleId || null,
            routingSource: decision.routingSource || null,
            routingRevision: decision.routingRevision || null,
            hostSession,
            hostSessionId: hostSession.sessionId || hostSessionId,
            callNonce: id,
            candidates: new Map(),
            winner: null,
            finished: false,
            timer: null,
        };
        this.groups.set(group.id, group);
        this.byHostSession.set(group.hostSessionId, group);

        const results = await Promise.all(targets.map((target) => this._createCandidate(group, target)));
        if (!results.some(Boolean)) {
            this._cleanupNoAnswer(group, "multiring-no-candidate");
            throw Object.assign(new Error("No MULTI_RING candidate could be started"), {
                statusCode: 503,
                route: "webrtc-multiring",
            });
        }
        group.timer = setTimeout(() => this._cleanupNoAnswer(group, "inbound-timeout"), this.timeoutMs);
        return {
            ok: true,
            route: "webrtc-multiring",
            sessionId: group.hostSessionId,
            candidateCount: this._activeCandidates(group).length,
        };
    }

    async handleHttpSignal(offer = {}) {
        const candidate = this._candidateForOffer(offer);
        if (!candidate || candidate.status !== "ringing") return { handled: false };
        if (offer.type === "answer") {
            if (!candidate.httpAnswered) {
                await this.applySessionAnswer(candidate.legSession, offer);
                candidate.httpAnswered = true;
            }
            this.logger.log("[multiring] candidate transport answered", {
                call: candidate.group.id,
                target: candidate.ensName,
                routingGroupId: candidate.group.metadataGroupId,
            });
            return { handled: true, responseBody: { ok: true, sessionId: offer.sessionId } };
        }
        if (offer.type === "reject" || offer.type === "cancel") {
            this.closeCandidate(candidate, `multiring-${offer.type}`);
            if (this._activeCandidates(candidate.group).length === 0) {
                this._cleanupNoAnswer(candidate.group, "multiring-all-declined");
            }
            return { handled: true, responseBody: { ok: true, type: offer.type, sessionId: offer.sessionId } };
        }
        return { handled: false };
    }

    handleDataChannelOpen(hostSessionId, meta = {}) {
        const candidate = this._candidateForMeta(hostSessionId, meta);
        if (!candidate || candidate.status !== "ringing") return { handled: false };
        candidate.dataChannelOpen = true;
        return { handled: true };
    }

    handleDataChannelMessage(hostSessionId, message, meta = {}) {
        const candidate = this._candidateForMeta(hostSessionId, meta);
        if (!candidate) return { handled: false };
        if (candidate.status === "closed") return { handled: true, won: false };
        const action = message?.msgType === "signaling"
            ? message.action === "end-call" ? "end" : message.payload?.type
            : message?.action;
        if (action !== "answer") {
            if (action === "reject" || action === "cancel" || action === "end") {
                this.closeCandidate(candidate, `multiring-${action}`);
                if (this._activeCandidates(candidate.group).length === 0) {
                    this._cleanupNoAnswer(candidate.group, "multiring-all-declined");
                }
            }
            return { handled: true, won: false };
        }

        const group = candidate.group;
        if (group.winner) {
            if (group.winner !== candidate) this.closeCandidate(candidate, "multiring-loser");
            return {
                handled: true,
                won: group.winner === candidate,
                duplicate: group.winner === candidate,
                group,
                candidate,
            };
        }
        group.winner = candidate;
        candidate.status = "winner";
        if (group.timer) {
            clearTimeout(group.timer);
            group.timer = null;
        }
        for (const loser of group.candidates.values()) {
            if (loser !== candidate) this.closeCandidate(loser, "multiring-loser");
        }
        candidate.legSession.multiRingPreNegotiated = true;
        this.logger.log("[multiring] winner locked", {
            call: group.id,
            target: candidate.ensName,
            routingGroupId: group.metadataGroupId,
        });
        return { handled: true, won: true, duplicate: false, group, candidate };
    }

    handleTransportClosed(event = {}) {
        const candidate = this.byPeerConnection.get(event.pc);
        if (!candidate) return { handled: false };
        if (candidate.status === "winner") {
            this.failHandoff(candidate.group, "multiring-winner-transport-closed");
            return { handled: true };
        }
        this.closeCandidate(candidate, "multiring-transport-closed");
        if (this._activeCandidates(candidate.group).length === 0) {
            this._cleanupNoAnswer(candidate.group, "multiring-all-transports-closed");
        }
        return { handled: true };
    }

    completeHandoff(group) {
        if (!group?.winner) return;
        this._finishGroup(group, { preserveWinnerPair: true });
    }

    failHandoff(group, reason = "multiring-handoff-failed") {
        if (!group || group.finished) return;
        for (const candidate of group.candidates.values()) this.closeCandidate(candidate, reason);
        this._finishGroup(group);
        this.destroySession(group.hostSessionId, false);
    }
}

module.exports = {
    DEFAULT_INBOUND_TIMEOUT_MS,
    MAX_TARGETS,
    MultiringCoordinator,
};
