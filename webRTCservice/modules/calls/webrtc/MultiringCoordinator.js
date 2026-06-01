class MultiringCoordinator {
    constructor({
        sessions,
        pendingBridgeRegistry,
        outboundLegFactory,
        sendNotification,
        sendDataChannelMessage,
        destroySession,
        onCallEvent = null,
        startWebRtcBridge,
        notiTypeCall,
        logger = console,
    } = {}) {
        Object.assign(this, {
            sessions,
            pendingBridgeRegistry,
            outboundLegFactory,
            sendNotification,
            sendDataChannelMessage,
            destroySession,
            onCallEvent,
            startWebRtcBridge,
            notiTypeCall,
            logger,
            ringGroups: new Map(),
            sessionToRingGroup: new Map(),
            pendingMultiBridgeStarts: new Map(),
            nextRingGroupId: 1,
        });
    }

    newRingGroupId() {
        const id = `mr-${Date.now()}-${this.nextRingGroupId}`;
        this.nextRingGroupId += 1;
        return id;
    }

    closeSessionNow(sessionId, reason = "multiring-cleanup") {
        const session = this.sessions.get(sessionId);
        if (!session) {
            const groupId = this.sessionToRingGroup.get(sessionId);
            const group = groupId ? this.ringGroups.get(groupId) : null;
            const callerSession = group ? this.sessions.get(group.callerSessionId) : null;
            const leg = callerSession?.outboundWebrtcLegs?.get(sessionId);
            if (!leg) return;
            try { leg.dataChannel?.close(); } catch (_) {}
            try { leg.peerConnection?.close(); } catch (_) {}
            callerSession.outboundWebrtcLegs.delete(sessionId);
            return;
        }
        const isWinnerLockedLoser = reason === "mr-loser-winner-locked";
        try {
            if (isWinnerLockedLoser) {
                this.sendDataChannelMessage(sessionId, { msgType: "call", action: "reject", reason: "cancelled-answered-elsewhere" });
            }
            this.sendDataChannelMessage(sessionId, { msgType: "call", action: "end", reason });
        } catch (_) {}
        const finalize = () => {
            this.onCallEvent(sessionId, {
                type: "call-cancel-requested",
                source: "multiring",
                route: "webrtc-multiring",
                reason,
                notifyClient: false,
                propagateLinkedSession: false,
            }).catch(() => {});
        };
        if (isWinnerLockedLoser) {
            setTimeout(finalize, 250);
            return;
        }
        finalize();
    }

    clearRingGroupTimeout(group) {
        if (!group || !group.timeoutHandle) return;
        clearTimeout(group.timeoutHandle);
        group.timeoutHandle = null;
    }

    clearRingGroupPendingEntries(group) {
        if (!group) return;
        for (const walletKey of group.pendingWallets) {
            this.pendingBridgeRegistry.remove(walletKey, (entry) => entry.kind === "multi" && entry.groupId === group.groupId);
        }
    }

    clearRingGroupMediaWatchers(group) {
        if (!group || !group.mediaWatchers) return;
        for (const watcher of group.mediaWatchers.values()) {
            if (watcher?.timer) {
                clearTimeout(watcher.timer);
                watcher.timer = null;
            }
            for (const sub of watcher?.subs || []) {
                const fn = typeof sub?.unSubscribe === "function" ? sub.unSubscribe : null;
                if (fn) {
                    try { fn(); } catch (_) {}
                }
            }
        }
        group.mediaWatchers.clear();
    }

    dropRingGroupTracking(group) {
        if (!group) return;
        this.clearRingGroupMediaWatchers(group);
        for (const sid of group.legSessionIds) {
            this.sessionToRingGroup.delete(sid);
        }
        this.ringGroups.delete(group.groupId);
    }

    markConnectedSession(group, sessionId) {
        if (!group) return;
        group.connectedSessions.add(sessionId);
        this.sessionToRingGroup.set(sessionId, group.groupId);
    }

    async createLegOffer(group, destination, legIndex) {
        const calleeWallet = destination.wallet;
        if (!calleeWallet || !(destination.ensName || calleeWallet)) return null;

        const walletKey = String(calleeWallet).toLowerCase();
        const legSessionId = walletKey;
        try {
            const {
                legSession,
                calleeEns,
                callerEns,
                callPayload,
            } = await this.outboundLegFactory.create(group.callerSessionId, destination, {
                legSessionId,
                kind: "multi",
                multiRingGroupId: group.groupId,
                payload: {
                    multiRingGroupId: group.groupId,
                },
            });

            group.pendingWallets.add(walletKey);
            group.legSessionIds.add(legSessionId);
            this.sessionToRingGroup.set(legSessionId, group.groupId);
            this.pendingBridgeRegistry.add(walletKey, {
                kind: "multi",
                groupId: group.groupId,
                callerSessionId: group.callerSessionId,
                walletKey,
                ensName: calleeEns,
                legSessionId,
            });

            legSession.lastNotificationResult = await this.sendNotification(callerEns, calleeEns, callPayload, this.notiTypeCall);
            this.logger.log(`[MR:${group.groupId}] leg invited sessionId=${legSessionId} to=${calleeEns}`);
            return legSessionId;
        } catch (err) {
            this.closeSessionNow(legSessionId, "mr-leg-offer-failed");
            group.legSessionIds.delete(legSessionId);
            this.sessionToRingGroup.delete(legSessionId);
            this.pendingBridgeRegistry.remove(walletKey, (entry) => entry.kind === "multi" && entry.groupId === group.groupId && entry.legSessionId === legSessionId);
            if (!this.pendingBridgeRegistry.has(walletKey, (entry) => entry.kind === "multi" && entry.groupId === group.groupId)) {
                group.pendingWallets.delete(walletKey);
            }
            throw err;
        }
    }

    commitWinner(group, winnerSessionId, source = "ready-session") {
        if (!group) return { handled: false };
        if (group.winnerSessionId && group.winnerSessionId !== winnerSessionId) {
            this.closeSessionNow(winnerSessionId, "mr-loser-late-ready");
            return { handled: true, won: false, winnerSessionId: group.winnerSessionId };
        }
        if (group.winnerSessionId === winnerSessionId) {
            return { handled: true, won: true, winnerSessionId };
        }

        group.winnerSessionId = winnerSessionId;
        group.closed = true;
        this.clearRingGroupTimeout(group);
        this.clearRingGroupPendingEntries(group);
        this.clearRingGroupMediaWatchers(group);

        for (const sid of group.legSessionIds) {
            if (sid === winnerSessionId) continue;
            this.closeSessionNow(sid, "mr-loser-winner-locked");
        }

        this.pendingMultiBridgeStarts.set(group.callerSessionId, winnerSessionId);
        this.logger.log(`[MR:${group.groupId}] winner locked from ${source} sessionId=${winnerSessionId}`);
        group.resolve(winnerSessionId);
        this.dropRingGroupTracking(group);
        return { handled: true, won: true, winnerSessionId };
    }

    commitWinnerFromAnswer(sessionId) {
        const groupId = this.sessionToRingGroup.get(sessionId);
        if (!groupId) return { handled: false };
        const group = this.ringGroups.get(groupId);
        if (!group || group.closed) return { handled: false };
        this.logger.log(`[MR:${group.groupId}] stage1 HTTP answer observed sessionId=${sessionId} (no winner lock)`);
        return { handled: true, won: false, pending: true };
    }

    commitWinnerFromDataChannelAnswer(sessionId) {
        const groupId = this.sessionToRingGroup.get(sessionId);
        if (!groupId) return { handled: false };
        const group = this.ringGroups.get(groupId);
        if (!group || group.closed) return { handled: false };
        return this.commitWinner(group, sessionId, "dc-answer");
    }

    async notifyAndBridgeMulti(callerSessionId, destinations) {
        const callerSession = this.sessions.get(callerSessionId);
        if (!callerSession) throw new Error("Caller session not found");

        const targets = Array.isArray(destinations) ? destinations : [];
        if (targets.length === 0) throw new Error("No multiring destinations provided");

        const groupId = this.newRingGroupId();
        const group = {
            groupId,
            callerSessionId,
            winnerSessionId: null,
            closed: false,
            pendingWallets: new Set(),
            legSessionIds: new Set(),
            connectedSessions: new Set(),
            mediaWatchers: new Map(),
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
            this.clearRingGroupPendingEntries(group);
            for (const sid of group.legSessionIds) {
                this.closeSessionNow(sid, "mr-timeout");
            }
            this.dropRingGroupTracking(group);
            this.logger.log(`[MR:${group.groupId}] timeout with no winner`);
            group.reject(new Error("No multiring callee answered within timeout"));
        }, 60000);

        this.ringGroups.set(groupId, group);
        this.logger.log(`[MR:${group.groupId}] created callerSessionId=${callerSessionId}`);

        const inviteJobs = targets.map((destination, idx) =>
            this.createLegOffer(group, destination, idx + 1)
        );
        const inviteResults = await Promise.allSettled(inviteJobs);
        inviteResults.forEach((result, idx) => {
            if (result.status === "rejected") {
                const legIndex = idx + 1;
                this.logger.error(`[MR:${group.groupId}] failed leg invite #${legIndex}: ${result.reason?.message || result.reason}`);
            }
        });

        if (group.pendingWallets.size === 0) {
            group.closed = true;
            this.clearRingGroupTimeout(group);
            this.dropRingGroupTracking(group);
            throw new Error("Multiring configured but no valid legs were created");
        }

        return winnerPromise;
    }

    checkPendingBridge(sessionId, pending) {
        if (pending.legSessionId && pending.legSessionId !== sessionId) return { handled: false, keep: true };
        const group = this.ringGroups.get(pending.groupId);
        if (!group || group.closed) return { handled: false, keep: false };
        if (group.winnerSessionId && group.winnerSessionId !== sessionId) {
            this.closeSessionNow(sessionId, "mr-loser-late-ready");
            return { handled: true, keep: false };
        }
        this.markConnectedSession(group, sessionId);
        return { handled: false, keep: false };
    }

    startPendingBridge(callerSessionId) {
        if (!callerSessionId) return false;
        const winnerSessionId = this.pendingMultiBridgeStarts.get(callerSessionId);
        if (!winnerSessionId) return false;
        this.pendingMultiBridgeStarts.delete(callerSessionId);
        this.startWebRtcBridge(callerSessionId, winnerSessionId);
        this.logger.log(`[MR] bridge started after answer callerSessionId=${callerSessionId} winnerSessionId=${winnerSessionId}`);
        return true;
    }
}

module.exports = {
    MultiringCoordinator,
};
