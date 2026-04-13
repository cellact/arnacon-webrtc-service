"use strict";

class SessionStore {
    constructor() {
        this.sessions = new Map();
        this.sessionsByUser = new Map();
        this.pendingBridges = new Map();
        this.pendingInboundCalls = new Map();
    }

    get(sessionId) {
        return this.sessions.get(sessionId);
    }

    set(sessionId, session) {
        this.sessions.set(sessionId, session);
        return session;
    }

    delete(sessionId) {
        return this.sessions.delete(sessionId);
    }

    has(sessionId) {
        return this.sessions.has(sessionId);
    }

    entries() {
        return this.sessions.entries();
    }

    linkUser(identityKey, sessionId) {
        this.sessionsByUser.set(identityKey, sessionId);
    }

    unlinkUser(identityKey) {
        this.sessionsByUser.delete(identityKey);
    }

    getByUser(identityKey) {
        const sid = this.sessionsByUser.get(identityKey);
        if (!sid) return null;
        return this.sessions.get(sid) || null;
    }

    stableKey(a, b) {
        return [a, b].sort().join("|");
    }

    createSession(sessionId, callerEns, toIdentity, logger = console) {
        const session = {
            sessionId,
            callerEns,
            toIdentity: toIdentity || null,
            phase: "handshake",
            createdAt: Date.now(),
            peerConnection: null,
            dataChannel: null,
            iceCandidates: [],
            remoteTracks: [],
            localAudioTrack: null,
            connectionState: "new",
            disconnectTimer: null,
            walletAddress: null,
            sipConnection: null,
            sipPeerConnection: null,
            sipLocalAudioTrack: null,
            mediaRelayActive: false,
            signalingQueue: Promise.resolve(),
            linkedSessionId: null,
            callEndInProgress: false,
            inboundRingSent: false,
        };
        this.sessions.set(sessionId, session);
        if (callerEns && toIdentity) {
            this.sessionsByUser.set(this.stableKey(callerEns, toIdentity), sessionId);
        }
        logger.log(`[${sessionId}] Session created for ${callerEns}`);
        return session;
    }

    destroySession(sessionId, opts = {}) {
        const {
            notify = false,
            sendDataChannelMessage = null,
            closeSipSession = null,
            logger = console,
        } = opts;
        const session = this.sessions.get(sessionId);
        if (!session) return;

        if (session.disconnectTimer) {
            clearTimeout(session.disconnectTimer);
            session.disconnectTimer = null;
        }

        if (session.callerEns && session.toIdentity) {
            const key = this.stableKey(session.callerEns, session.toIdentity);
            if (this.sessionsByUser.get(key) === sessionId) {
                this.sessionsByUser.delete(key);
            }
        }

        if (notify && sendDataChannelMessage) {
            try {
                sendDataChannelMessage(sessionId, { msgType: "session", action: "destroyed", sessionId });
            } catch (_) {}
        }

        if (session.dataChannel) {
            try { session.dataChannel.close(); } catch (_) {}
            session.dataChannel = null;
        }

        if (session.peerConnection) {
            const pc = session.peerConnection;
            session.peerConnection = null;
            try { pc.close(); } catch (_) {}
        }

        if (session.sipConnection && closeSipSession) {
            try { closeSipSession(sessionId); } catch (_) {}
        }

        this.sessions.delete(sessionId);
        logger.log(`[${sessionId}] Session destroyed`);
    }

    normalizeNumber(value) {
        if (!value) return null;
        return String(value).replace(/^\+/, "");
    }

    buildLinkIdentityVariants(value, parseAddress) {
        const parsed = parseAddress(value || "");
        const base = this.normalizeNumber(parsed.value);
        if (!base) return new Set();
        const variants = new Set([base]);
        const isDigitsOnly = /^\d+$/.test(base);
        if (!isDigitsOnly) return variants;
        if (base.startsWith("0") && base.length > 1) variants.add(`972${base.slice(1)}`);
        if (base.startsWith("972") && base.length > 3) variants.add(`0${base.slice(3)}`);
        if (base.length === 9 && !base.startsWith("0") && !base.startsWith("972")) {
            variants.add(`0${base}`);
            variants.add(`972${base}`);
        }
        return variants;
    }

    hasAnyVariantMatch(aSet, bSet) {
        if (!aSet || !bSet) return false;
        for (const a of aSet) {
            if (bSet.has(a)) return true;
        }
        return false;
    }

    findOutboundSessionForInbound(fromNumber, toNumber, parseAddress, excludeSessionId = null, logger = console) {
        const inboundFromVariants = this.buildLinkIdentityVariants(fromNumber, parseAddress);
        const inboundToVariants = this.buildLinkIdentityVariants(toNumber, parseAddress);
        if (!inboundFromVariants.size || !inboundToVariants.size) return null;
        const fromOnlyCandidates = [];

        for (const [sid, s] of this.sessions.entries()) {
            if (!s || sid === excludeSessionId) continue;
            if (s.isGatewayCaller) continue;
            const callerVariants = this.buildLinkIdentityVariants(s.callerEns || "", parseAddress);
            const calleeVariants = this.buildLinkIdentityVariants(s.toIdentity || "", parseAddress);
            const callerMatched = this.hasAnyVariantMatch(callerVariants, inboundFromVariants);
            const calleeMatched = this.hasAnyVariantMatch(calleeVariants, inboundToVariants);
            if (callerMatched && calleeMatched) return sid;
            if (callerMatched && s.phase !== "post-call" && !s.linkedSessionId) {
                fromOnlyCandidates.push({ sid, createdAt: s.createdAt || 0 });
            }
        }

        if (fromOnlyCandidates.length === 1) return fromOnlyCandidates[0].sid;
        if (fromOnlyCandidates.length > 1) {
            fromOnlyCandidates.sort((a, b) => b.createdAt - a.createdAt);
            const newest = fromOnlyCandidates[0];
            const second = fromOnlyCandidates[1];
            if (newest && second && newest.createdAt !== second.createdAt) return newest.sid;
            logger.log(
                `[Link] Ambiguous outbound fallback for inbound from=${fromNumber} to=${toNumber}; candidates=${fromOnlyCandidates.length}`,
            );
        }
        return null;
    }

    linkSessionPair(aId, bId, logger = console) {
        const a = this.sessions.get(aId);
        const b = this.sessions.get(bId);
        if (!a || !b) return;
        a.linkedSessionId = bId;
        b.linkedSessionId = aId;
        logger.log(`[Link] Linked sessions ${aId} <-> ${bId}`);
    }
}

function createSessionStore() {
    return new SessionStore();
}

module.exports = {
    SessionStore,
    createSessionStore,
};
