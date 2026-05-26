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
    onDataChannelOpen = null,
    onDataChannelMessage = null,
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
        const isWinnerLockedLoser = reason === "mr-loser-winner-locked";
        try {
            if (isWinnerLockedLoser) {
                // Losing leg should get a clear "someone else answered" semantic before hangup.
                sendDataChannelMessage(sessionId, { msgType: "call", action: "reject", reason: "cancelled-answered-elsewhere" });
            }
            sendDataChannelMessage(sessionId, { msgType: "call", action: "end", reason });
        } catch (_) {}
        const finalize = () => {
            if (typeof destroySession !== "function") return;
            try { destroySession(sessionId, false); } catch (_) {}
        };
        if (isWinnerLockedLoser) {
            // Give DC control messages a short chance to flush before tearing down.
            setTimeout(finalize, 250);
            return;
        }
        finalize();
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

    function narrowAudioOfferToPayloads(sdp, allowedPayloads) {
        if (!sdp || !sdp.includes("m=audio")) return sdp;
        const allowedPayloadSet = new Set((allowedPayloads || []).map(String));
        if (allowedPayloadSet.size === 0) return sdp;
        const sections = sdp.split(/\r\n(?=m=)/);
        return sections.map((section) => {
            if (!section.startsWith("m=audio")) return section;
            const lines = section.split(/\r\n/);
            const mLine = lines[0].split(" ");
            const payloads = mLine.slice(3).filter((pt) => allowedPayloadSet.has(pt));
            if (!payloads.length) return section;

            const allowed = new Set(payloads);
            const filtered = lines.filter((line, index) => {
                if (index === 0) return true;
                const payloadMatch = line.match(/^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)(?:\s|$)/);
                return !payloadMatch || allowed.has(payloadMatch[1]);
            });
            filtered[0] = [...mLine.slice(0, 3), ...payloads].join(" ");
            return filtered.join("\r\n");
        }).join("\r\n");
    }

    function narrowAudioOfferForCodecPolicy(sdp, codecPolicy) {
        if (codecPolicy === "opus") return narrowAudioOfferToPayloads(sdp, ["111"]);
        if (codecPolicy === "pcmu") return narrowAudioOfferToPayloads(sdp, ["0"]);
        if (codecPolicy === "pcma") return narrowAudioOfferToPayloads(sdp, ["8"]);
        if (codecPolicy === "g711") return narrowAudioOfferToPayloads(sdp, ["0", "8"]);
        return sdp;
    }

    function attachOutboundDataChannel(legSessionId, legSession) {
        const pc = createPeerConnection(legSessionId);
        if (typeof pc.createDataChannel !== "function") return pc;

        const dc = pc.createDataChannel("chat");
        if (!dc) return pc;

        legSession.dataChannel = dc;
        dc.onopen = () => {
            if (typeof onDataChannelOpen === "function") {
                onDataChannelOpen(legSessionId);
            }
        };
        dc.onMessage.subscribe((msg) => {
            if (typeof onDataChannelMessage !== "function") return;
            const raw = typeof msg === "string" ? msg : Buffer.from(msg).toString("utf-8");
            onDataChannelMessage(legSessionId, raw);
        });
        dc.onclose = () => logger.log(`[${legSessionId}] Data channel closed`);
        return pc;
    }

    async function createWebrtcOutboundLeg(callerSessionId, destination, options = {}) {
        const callerSession = sessions.get(callerSessionId);
        if (!callerSession) throw new Error("Caller session not found");

        const calleeWallet = destination.wallet;
        const calleeEns = destination.ensName || calleeWallet;
        const callerEns = callerSession.callerEns;
        const callerNumberLabel = getCallerNumberLabel(callerEns);
        const walletKey = String(calleeWallet || "").toLowerCase();
        const legSessionId = options.legSessionId || `${callerSessionId}-webrtc-${Date.now()}`;
        if (!calleeWallet || !calleeEns) {
            throw new Error("WebRTC destination missing callee wallet/ENS");
        }

        const legSession = createSession(legSessionId, callerEns, calleeEns);
        legSession.isGatewayCaller = true;
        legSession.outboundWebrtcLeg = true;
        legSession.outboundBridgeKind = options.kind || "single";
        legSession.walletAddress = walletKey;
        legSession.serviceId = callerSession.serviceId || null;
        legSession.mediaCodecPolicy = callerSession.mediaCodecPolicy || null;
        if (options.multiRingGroupId) {
            legSession.multiRingGroupId = options.multiRingGroupId;
            legSession.multiRingLeg = true;
        }

        const pc = attachOutboundDataChannel(legSessionId, legSession);
        legSession.localAudioTrack = new MediaStreamTrack({ kind: "audio" });
        pc.addTrack(legSession.localAudioTrack);
        legSession.iceCandidates = [];

        const offer = await pc.createOffer();
        let baseOfferSdp = offer.sdp;
        if (callerSession.mediaCodecPolicy) {
            const narrowedOfferSdp = narrowAudioOfferForCodecPolicy(baseOfferSdp, callerSession.mediaCodecPolicy);
            if (narrowedOfferSdp !== baseOfferSdp) {
                logger.log(`[${legSessionId}] WebRTC leg inherited bridge codec policy=${callerSession.mediaCodecPolicy}`);
                baseOfferSdp = narrowedOfferSdp;
                offer.sdp = baseOfferSdp;
            }
        }
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
        const offerSdp = embedCandidatesInSdp(baseOfferSdp, candidatesToEmbed);
        const sourceOffer = callerSession.lastRingOfferPayload || null;

        const callPayload = JSON.stringify({
            type: "offer",
            from: callerNumberLabel || callerEns,
            to: calleeEns,
            sessionId: legSessionId,
            label: callerNumberLabel || undefined,
            callerEns,
            sdp: offerSdp,
            candidates: relayCandidates,
            callNonce: sourceOffer?.callNonce || null,
            isCall: true,
            ...(options.payload || {}),
        });
        logger.log(
            `[${legSessionId}] outbound WebRTC invite payload from=${callerNumberLabel || callerEns} ` +
            `to=${calleeEns} callerEns=${callerEns}`
        );

        return {
            callerSession,
            legSession,
            legSessionId,
            walletKey,
            calleeEns,
            callerEns,
            callPayload,
        };
    }

    function waitForWebrtcPickup(callerSessionId, legSessionId, walletKey, timeoutReason = "webrtc-pickup-timeout") {
        const BRIDGE_TIMEOUT = 60000;
        let timer = null;
        let rejectPickup = null;
        const promise = new Promise((resolve, reject) => {
            rejectPickup = reject;
            timer = setTimeout(() => {
                removePendingEntries(walletKey, (entry) => entry.kind === "webrtc" && entry.callerSessionId === callerSessionId);
                closeSessionNow(legSessionId, timeoutReason);
                reject(new Error("Callee did not connect within timeout"));
            }, BRIDGE_TIMEOUT);

            addPendingEntry(walletKey, {
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
            cancel(reason = "webrtc-pickup-cancelled") {
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
                removePendingEntries(walletKey, (entry) => entry.kind === "webrtc" && entry.legSessionId === legSessionId);
                if (typeof rejectPickup === "function") {
                    rejectPickup(new Error(reason));
                }
            },
        };
    }

    function connectWebrtcSessions(callerSessionId, calleeSessionId) {
        startWebRtcBridge(callerSessionId, calleeSessionId);
        logger.log(`[Bridge] WebRTC callee connected callerSessionId=${callerSessionId} calleeSessionId=${calleeSessionId}`);
    }

    async function notifyAndBridge(callerSessionId, destination) {
        const {
            legSession,
            legSessionId,
            walletKey,
            calleeEns,
            callerEns,
            callPayload,
        } = await createWebrtcOutboundLeg(callerSessionId, destination, { kind: "webrtc" });

        const pickup = waitForWebrtcPickup(callerSessionId, legSessionId, walletKey);
        try {
            legSession.lastNotificationResult = await sendNotification(callerEns, calleeEns, callPayload, notiTypeCall);
        } catch (err) {
            pickup.promise.catch(() => {});
            pickup.cancel("webrtc-notification-failed");
            closeSessionNow(legSessionId, "webrtc-notification-failed");
            throw err;
        }
        const calleeSessionId = await pickup.promise;
        connectWebrtcSessions(callerSessionId, calleeSessionId);
        return calleeSessionId;
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

    function clearRingGroupMediaWatchers(group) {
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

    function dropRingGroupTracking(group) {
        if (!group) return;
        clearRingGroupMediaWatchers(group);
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

    async function createMultiringLegOffer(group, destination, legIndex) {
        const calleeWallet = destination.wallet;
        if (!calleeWallet || !(destination.ensName || calleeWallet)) return null;

        const walletKey = String(calleeWallet).toLowerCase();
        const legSessionId = `${group.groupId}-leg${legIndex}`;
        try {
            const {
                legSession,
                calleeEns,
                callerEns,
                callPayload,
            } = await createWebrtcOutboundLeg(group.callerSessionId, destination, {
                legSessionId,
                kind: "multi",
                multiRingGroupId: group.groupId,
                payload: {
                    multiRingGroupId: group.groupId,
                },
            });

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

            legSession.lastNotificationResult = await sendNotification(callerEns, calleeEns, callPayload, notiTypeCall);
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

    function commitWinner(group, winnerSessionId, source = "ready-session") {
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
        clearRingGroupMediaWatchers(group);

        for (const sid of group.legSessionIds) {
            if (sid === winnerSessionId) continue;
            closeSessionNow(sid, "mr-loser-winner-locked");
        }

        // Do not start media bridge here for multiring.
        // callFlow will start it explicitly after sending the caller's ANSWER.
        pendingMultiBridgeStarts.set(group.callerSessionId, winnerSessionId);
        logger.log(`[MR:${group.groupId}] winner locked from ${source} sessionId=${winnerSessionId}`);
        group.resolve(winnerSessionId);
        dropRingGroupTracking(group);
        return { handled: true, won: true, winnerSessionId };
    }

    function commitWinnerFromAnswer(sessionId) {
        const groupId = sessionToRingGroup.get(sessionId);
        if (!groupId) return { handled: false };
        const group = ringGroups.get(groupId);
        if (!group || group.closed) return { handled: false };
        logger.log(`[MR:${group.groupId}] stage1 HTTP answer observed sessionId=${sessionId} (no winner lock)`);
        return { handled: true, won: false, pending: true };
    }

    function commitWinnerFromDataChannelAnswer(sessionId) {
        const groupId = sessionToRingGroup.get(sessionId);
        if (!groupId) return { handled: false };
        const group = ringGroups.get(groupId);
        if (!group || group.closed) return { handled: false };
        return commitWinner(group, sessionId, "dc-answer");
    }

    async function notifyAndBridgeMulti(callerSessionId, destinations) {
        const callerSession = sessions.get(callerSessionId);
        if (!callerSession) throw new Error("Caller session not found");

        const targets = Array.isArray(destinations) ? destinations : [];
        if (targets.length === 0) throw new Error("No multiring destinations provided");

        const groupId = newRingGroupId();
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

        const inviteJobs = targets.map((destination, idx) =>
            createMultiringLegOffer(group, destination, idx + 1)
        );
        const inviteResults = await Promise.allSettled(inviteJobs);
        inviteResults.forEach((result, idx) => {
            if (result.status === "rejected") {
                const legIndex = idx + 1;
                logger.error(`[MR:${group.groupId}] failed leg invite #${legIndex}: ${result.reason?.message || result.reason}`);
            }
        });

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
        callerSession.linkedSessionId = calleeSessionId;
        calleeSession.linkedSessionId = callerSessionId;
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
        let currentCallerTrack = null;
        let currentCalleeTrack = null;
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
            currentCallerTrack = track;
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
            currentCalleeTrack = track;
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
            const addTrack = (t) => {
                if (!t || t.kind !== "audio") return;
                if (seen.has(t)) return;
                seen.add(t);
                out.push(t);
            };

            // Prefer the current receiver/transceiver track. Stored onTrack values can
            // point at an older non-emitting track after renegotiation.
            if (session?.peerConnection?.getReceivers) {
                for (const recv of session.peerConnection.getReceivers()) {
                    addTrack(recv?.track);
                }
            }
            if (session?.peerConnection?.getTransceivers) {
                for (const tr of session.peerConnection.getTransceivers()) {
                    if (tr?.kind !== "audio" || !tr.receiver?.tracks) continue;
                    for (const t of tr.receiver.tracks) {
                        addTrack(t);
                    }
                }
            }
            for (const t of session?.remoteTracks || []) {
                addTrack(t);
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
            // If we latched onto a non-emitting track during bridge start,
            // force a one-step fallback rebind to another known audio track.
            if (w2cPackets === 0) {
                const altCalleeTrack = getReceiverAudioTracks(calleeSession).find((t) => t !== currentCalleeTrack);
                if (altCalleeTrack) {
                    logger.log(`[Bridge][${callerSessionId}<->${calleeSessionId}] fallback rebind callee->caller`);
                    rebindCalleeToCaller(altCalleeTrack);
                }
            }
            if (c2wPackets === 0) {
                const altCallerTrack = getReceiverAudioTracks(callerSession).find((t) => t !== currentCallerTrack);
                if (altCallerTrack) {
                    logger.log(`[Bridge][${callerSessionId}<->${calleeSessionId}] fallback rebind caller->callee`);
                    rebindCallerToCallee(altCallerTrack);
                } else if (currentCallerTrack) {
                    logger.log(`[Bridge][${callerSessionId}<->${calleeSessionId}] retry rebind caller->callee current track`);
                    rebindCallerToCallee(currentCallerTrack);
                } else {
                    logger.warn(`[Bridge][${callerSessionId}<->${calleeSessionId}] no caller audio receiver track available`);
                }
            }
            logger.log(`[Bridge][${callerSessionId}<->${calleeSessionId}] rtp c2w=${c2wPackets} w2c=${w2cPackets}`);
        }, 2000);
        logger.log(`[Bridge] WebRTC bridge initiated between ${callerSessionId} and ${calleeSessionId}`);
    }

    function commitWebrtcBridgePickup(sessionId) {
        if (!sessionId) return { handled: false };
        for (const [walletKey, list] of pendingBridges.entries()) {
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
            setPendingList(walletKey, nextList);
            matched.resolve(sessionId);
            logger.log(`[Bridge] WebRTC pickup confirmed sessionId=${sessionId}`);
            return { handled: true, sessionId };
        }
        return { handled: false };
    }

    function checkPendingBridge(sessionId, walletAddress) {
        if (!walletAddress) return false;
        const key = walletAddress.toLowerCase();
        const list = getPendingList(key);
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
                const session = sessions.get(sessionId);
                if (session) session.outboundWebrtcTransportReady = true;
                // Keep pending open until the callee answers the stage2 RING
                // over data channel. HTTP/WebRTC readiness is not pickup.
                nextList.push(pending);
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
        commitWinnerFromAnswer,
        commitWinnerFromDataChannelAnswer,
        commitWebrtcBridgePickup,
        checkPendingBridge,
        checkPendingInboundCall,
        handleIceRestart,
    };
}

module.exports = {
    createBridgeApi,
};
