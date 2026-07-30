const { ethers } = require("ethers");
const { createIdentityMappingAuthService } = require("../../../services/identityMappingAuthService");

function createBlockchainApi({
    config,
    providerPolicy = null,
    createHttpError,
    logger = console,
}) {
    const POLYGON_RPC = config.polygon.rpc;
    const ENS_REGISTRY_ADDRESS = config.polygon.ENSRegistry;
    const NAME_WRAPPER_ADDRESS = config.polygon.NameWrapper;
    const SERVICE_PROVIDER_REGISTRY_ADDRESS = config.polygon.ServiceProviderRegistry;
    const SAPPHIRE_RPC = config.sapphire.rpc;
    const SAPPHIRE_TESTNET_RPC = config.sapphireTestnet.rpc;
    const NFT_CALLER_ID_POOL_ADDRESS = config.sapphireTestnet.NFTCallerIdPool;
    const ROFL_LOGIC_CONFIG = config.roflLogic || {};
    const ROFL_BUSINESS_NUMBER_DB_CONFIG = ROFL_LOGIC_CONFIG.businessNumberDb || {};
    const ROFL_CALLER_ID_POOL_CONFIG = ROFL_LOGIC_CONFIG.callerIdPool || {};
    const ROFL_LOGIC_RPC =
        process.env.ROFL_LOGIC_RPC_URL ||
        ROFL_LOGIC_CONFIG.rpc ||
        SAPPHIRE_TESTNET_RPC ||
        SAPPHIRE_RPC;
    const ROFL_LOGIC_CHAIN_ID =
        Number(process.env.ROFL_LOGIC_CHAIN_ID || ROFL_LOGIC_CONFIG.chainId || 0) || undefined;
    const ROFL_BUSINESS_NUMBER_DB_RPC =
        process.env.ROFL_LOGIC_BUSINESS_NUMBER_DB_RPC_URL ||
        ROFL_BUSINESS_NUMBER_DB_CONFIG.rpc ||
        ROFL_LOGIC_RPC;
    const ROFL_BUSINESS_NUMBER_DB_CHAIN_ID =
        Number(
            process.env.ROFL_LOGIC_BUSINESS_NUMBER_DB_CHAIN_ID ||
            ROFL_BUSINESS_NUMBER_DB_CONFIG.chainId ||
            ROFL_LOGIC_CHAIN_ID ||
            0,
        ) || undefined;
    const ROFL_BUSINESS_NUMBER_DB_ADDRESS =
        process.env.ROFL_LOGIC_BUSINESS_NUMBER_DB_ADDRESS ||
        ROFL_BUSINESS_NUMBER_DB_CONFIG.address ||
        ROFL_LOGIC_CONFIG.businessNumberDbAddress ||
        "";
    const ROFL_CALLER_ID_POOL_RPC =
        process.env.ROFL_LOGIC_CALLER_ID_POOL_RPC_URL ||
        ROFL_CALLER_ID_POOL_CONFIG.rpc ||
        ROFL_LOGIC_RPC;
    const ROFL_CALLER_ID_POOL_CHAIN_ID =
        Number(
            process.env.ROFL_LOGIC_CALLER_ID_POOL_CHAIN_ID ||
            ROFL_CALLER_ID_POOL_CONFIG.chainId ||
            ROFL_LOGIC_CHAIN_ID ||
            0,
        ) || undefined;
    const ROFL_CALLER_ID_POOL_ADDRESS =
        process.env.ROFL_LOGIC_CALLER_ID_POOL_ADDRESS ||
        ROFL_CALLER_ID_POOL_CONFIG.address ||
        ROFL_LOGIC_CONFIG.callerIdPoolAddress ||
        NFT_CALLER_ID_POOL_ADDRESS;
    const ROFL_PKEY = process.env.ROFL_LOGIC_PKEY || process.env.PKEY || "";
    const IDENTITY_MAPPING_CONFIG = config.identityMapping || {};
    const DEFAULT_NOTIFICATION_PROVIDER_ADDRESS = "0xf648a26677aa51e62fFEaE40B2c7C8E26e0f464d";
    const GCP_ANS_MAPPING_URL = String(
        process.env.GCP_ANS_MAPPING_URL ||
        process.env.ARNACON_GCP_ANS_MAPPING_URL ||
        IDENTITY_MAPPING_CONFIG.ansMappingUrl ||
        "",
    ).trim();
    const GCP_WEB3_IDENTITY_MAPPING_URL = String(
        process.env.GCP_WEB3_IDENTITY_MAPPING_URL ||
        process.env.ARNACON_GCP_WEB3_IDENTITY_MAPPING_URL ||
        IDENTITY_MAPPING_CONFIG.web3IdentityMappingUrl ||
        "",
    ).trim();
    const GCP_MAPPING_REQUEST_TIMEOUT_MS = Number(
        process.env.GCP_MAPPING_TIMEOUT_MS ||
        process.env.ARNACON_GCP_MAPPING_TIMEOUT_MS ||
        IDENTITY_MAPPING_CONFIG.timeoutMs ||
        2500,
    );
    const identityMappingAuthService = createIdentityMappingAuthService({
        identityMappingConfig: IDENTITY_MAPPING_CONFIG,
        logger,
        timeoutMs: GCP_MAPPING_REQUEST_TIMEOUT_MS,
    });
    const SECNUM_DOMAINS = new Set(["secnum.global", "secnumtest.global"]);
    const NOTIFICATION_PROVIDER_ADDRESS = normalizeContractAddress(
        process.env.NOTIFICATION_PROVIDER_ADDRESS ||
        process.env.SECNUM_NOTIFICATION_PROVIDER_ADDRESS ||
        config.notificationProviderAddress ||
        config.notificationProvider?.address ||
        DEFAULT_NOTIFICATION_PROVIDER_ADDRESS,
    );
    const NOTIFICATION_PROVIDER_APPLY_ALL = String(
        process.env.NOTIFICATION_PROVIDER_APPLY_ALL ||
        config.notificationProviderApplyAll ||
        "false",
    ).toLowerCase() === "true";

    const ENS_REGISTRY_ABI = [
        "function owner(bytes32 node) view returns (address)",
        "function resolver(bytes32 node) view returns (address)",
    ];
    const NAME_WRAPPER_ABI = ["function ownerOf(uint256 tokenId) view returns (address)"];
    const ENS_PUBLIC_RESOLVER_ABI = [
        "function addr(bytes32 node) view returns (address)",
        "function text(bytes32 node, string key) view returns (string)",
    ];
    const SERVICE_PROVIDER_REGISTRY_ABI = [
        "function serviceRegistry() view returns (address)",
    ];
    const SERVICE_REGISTRY_ABI = [
        "function getServiceContract(bytes32 node) view returns (address)",
    ];
    const NFT_CALLER_ID_POOL_ABI = [
        "function balanceOf(address owner) view returns (uint256)",
        "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
        "function getCallerIdByTokenId(uint256 tokenId) view returns (string phoneNumber, string metadata, address owner)",
    ];
    const BUSINESS_NUMBER_DB_ABI = [
        "function getPhoneNumber(string identifier) view returns (string)",
    ];
    const CALLER_ID_POOL_ROFL_ABI = [
        "function findNextOwnedCallerId(uint256 startIndex, address expectedOwner, uint256 maxAttempts) view returns (string phoneNumber, uint256 foundIndex, bool found)",
        "function getPoolSize() view returns (uint256)",
        "function admin() view returns (address)",
        "function tokenByIndex(uint256 index) view returns (uint256)",
        "function getCallerIdByTokenId(uint256 tokenId) view returns (string phoneNumber, string metadata, address owner)",
    ];

    let polygonProvider = null;
    let sapphireProvider = null;
    let sapphireTestnetProvider = null;
    let roflLogicProvider = null;
    let businessNumberDbProvider = null;
    let callerIdPoolProvider = null;
    let businessNumberDbContract = null;
    let callerIdPoolRoflContract = null;
    let roflPoolOwnerAddress = null;
    let roflCallerIdIndex = 0;
    let roflAddress = null;
    let roflOwnerResolved = false;
    let mappingConfigLogged = false;

    function logMappingConfig() {
        if (mappingConfigLogged) return;
        mappingConfigLogged = true;
        const authSnapshot = identityMappingAuthService.getConfigSnapshot();
        logger.log("[IdentityMapping] config", {
            configured: Boolean((authSnapshot.hasServiceAccount || authSnapshot.hasTokenFile) && GCP_ANS_MAPPING_URL),
            authMode: authSnapshot.authMode,
            tokenFile: authSnapshot.tokenFile,
            serviceAccountJsonFile: authSnapshot.serviceAccountJsonFile,
            idTokenAudience: authSnapshot.idTokenAudience,
            oauthTokenUrl: authSnapshot.oauthTokenUrl,
            ansMappingUrl: GCP_ANS_MAPPING_URL || null,
            web3IdentityMappingUrl: GCP_WEB3_IDENTITY_MAPPING_URL || null,
            timeoutMs: Number.isFinite(GCP_MAPPING_REQUEST_TIMEOUT_MS) && GCP_MAPPING_REQUEST_TIMEOUT_MS > 0
                ? GCP_MAPPING_REQUEST_TIMEOUT_MS
                : 2500,
        });
    }

    function getPolygonProvider() {
        if (!polygonProvider) polygonProvider = new ethers.providers.JsonRpcProvider(POLYGON_RPC);
        return polygonProvider;
    }

    function getSapphireProvider() {
        if (!sapphireProvider) sapphireProvider = new ethers.providers.JsonRpcProvider(SAPPHIRE_RPC);
        return sapphireProvider;
    }

    function getSapphireTestnetProvider() {
        if (!sapphireTestnetProvider) sapphireTestnetProvider = new ethers.providers.JsonRpcProvider(SAPPHIRE_TESTNET_RPC);
        return sapphireTestnetProvider;
    }

    function getRoflLogicProvider() {
        if (!roflLogicProvider) {
            if (ROFL_LOGIC_CHAIN_ID) {
                roflLogicProvider = new ethers.providers.JsonRpcProvider(ROFL_LOGIC_RPC, ROFL_LOGIC_CHAIN_ID);
            } else {
                roflLogicProvider = new ethers.providers.JsonRpcProvider(ROFL_LOGIC_RPC);
            }
        }
        return roflLogicProvider;
    }

    function getBusinessNumberDbProvider() {
        if (!businessNumberDbProvider) {
            if (ROFL_BUSINESS_NUMBER_DB_CHAIN_ID) {
                businessNumberDbProvider = new ethers.providers.JsonRpcProvider(
                    ROFL_BUSINESS_NUMBER_DB_RPC,
                    ROFL_BUSINESS_NUMBER_DB_CHAIN_ID,
                );
            } else {
                businessNumberDbProvider = new ethers.providers.JsonRpcProvider(ROFL_BUSINESS_NUMBER_DB_RPC);
            }
        }
        return businessNumberDbProvider;
    }

    function getCallerIdPoolProvider() {
        if (!callerIdPoolProvider) {
            if (ROFL_CALLER_ID_POOL_CHAIN_ID) {
                callerIdPoolProvider = new ethers.providers.JsonRpcProvider(
                    ROFL_CALLER_ID_POOL_RPC,
                    ROFL_CALLER_ID_POOL_CHAIN_ID,
                );
            } else {
                callerIdPoolProvider = new ethers.providers.JsonRpcProvider(ROFL_CALLER_ID_POOL_RPC);
            }
        }
        return callerIdPoolProvider;
    }

    function normalizeContractAddress(value) {
        const normalized = String(value || "").trim();
        if (!normalized || normalized === "0x0000000000000000000000000000000000000000") return "";
        return normalized;
    }

    function toSafeNumber(value, fallback = 0) {
        if (typeof value === "number") return value;
        if (typeof value === "bigint") return Number(value);
        if (value && typeof value.toString === "function") return Number(value.toString());
        return fallback;
    }

    function getRoflAddress() {
        if (!roflAddress && ROFL_PKEY) {
            try {
                roflAddress = new ethers.Wallet(ROFL_PKEY).address;
            } catch (err) {
                logger.error(`[ROFL_LOCAL] invalid PKEY: ${err.message}`);
            }
        }
        return roflAddress;
    }

    function getBusinessNumberDbContract() {
        if (!businessNumberDbContract) {
            const address = normalizeContractAddress(ROFL_BUSINESS_NUMBER_DB_ADDRESS);
            if (!address) return null;
            businessNumberDbContract = new ethers.Contract(address, BUSINESS_NUMBER_DB_ABI, getBusinessNumberDbProvider());
        }
        return businessNumberDbContract;
    }

    function getRoflCallerIdPoolContract() {
        if (!callerIdPoolRoflContract) {
            const address = normalizeContractAddress(ROFL_CALLER_ID_POOL_ADDRESS);
            if (!address) return null;
            callerIdPoolRoflContract = new ethers.Contract(address, CALLER_ID_POOL_ROFL_ABI, getCallerIdPoolProvider());
        }
        return callerIdPoolRoflContract;
    }

    async function getRoflPoolOwnerAddress() {
        if (roflOwnerResolved) return roflPoolOwnerAddress || getRoflAddress();

        roflOwnerResolved = true;
        const pool = getRoflCallerIdPoolContract();
        if (!pool) {
            roflPoolOwnerAddress = getRoflAddress();
            return roflPoolOwnerAddress;
        }
        try {
            roflPoolOwnerAddress = await pool.admin();
        } catch (err) {
            logger.warn(`[ROFL_LOCAL] pool admin() failed, falling back to ROFL key address: ${err.message}`);
            roflPoolOwnerAddress = getRoflAddress();
        }
        return roflPoolOwnerAddress;
    }

    function isEthAddress(str) {
        return /^0x[0-9a-fA-F]{40}$/.test(str);
    }

    function normalizePhoneLabel(value) {
        const raw = String(value || "").trim();
        if (!raw) return "";
        const normalized = raw.replace(/^\+/, "").replace(/\D/g, "");
        return /^\d+$/.test(normalized) ? normalized : "";
    }

    function deriveWeb2Identity(identity) {
        let value = String(identity || "").trim();
        if (!value) return "";
        if (/^sip:/i.test(value)) value = value.slice(4);
        value = value.split(";")[0];
        value = value.split("@")[0];
        if (value.includes(".")) value = value.split(".")[0];
        return normalizePhoneLabel(value);
    }

    async function fetchJsonWithBearer(baseUrl, queryParams, contextLabel) {
        logMappingConfig();
        const token = await identityMappingAuthService.getBearerToken(baseUrl, contextLabel);
        if (!baseUrl || !token) {
            logger.log("[IdentityMapping] request skipped (missing config)", {
                context: contextLabel,
                hasUrl: Boolean(baseUrl),
                hasToken: Boolean(token),
            });
            return null;
        }
        const timeoutMs = Number.isFinite(GCP_MAPPING_REQUEST_TIMEOUT_MS) && GCP_MAPPING_REQUEST_TIMEOUT_MS > 0
            ? GCP_MAPPING_REQUEST_TIMEOUT_MS
            : 2500;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const url = new URL(baseUrl);
            for (const [key, value] of Object.entries(queryParams || {})) {
                if (value !== undefined && value !== null && String(value).trim() !== "") {
                    url.searchParams.set(key, String(value).trim());
                }
            }
            logger.log("[IdentityMapping] calling endpoint", {
                context: contextLabel,
                url: url.toString(),
            });
            const resp = await fetch(url.toString(), {
                method: "GET",
                headers: { Authorization: `Bearer ${token}` },
                signal: controller.signal,
            });
            if (!resp.ok) {
                const body = await resp.text().catch(() => "");
                logger.warn(`[IdentityMapping] ${contextLabel} http ${resp.status}: ${body}`);
                return null;
            }
            const payload = await resp.json().catch(() => null);
            const keys = payload && typeof payload === "object" ? Object.keys(payload) : [];
            logger.log("[IdentityMapping] response shape", {
                context: contextLabel,
                keys,
                hasWeb2Identity: Boolean(payload?.web2identity),
                hasWeb3Identity: Boolean(payload?.web3identity),
                hasWallet: Boolean(payload?.wallet),
            });
            return payload && typeof payload === "object" ? payload : null;
        } catch (err) {
            logger.warn(`[IdentityMapping] ${contextLabel} request error: ${err.message}`);
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    function checksumWalletOrNull(wallet) {
        const raw = String(wallet || "").trim();
        if (!raw) return null;
        if (!isEthAddress(raw)) return null;
        return ethers.utils.getAddress(raw);
    }

    async function resolveWalletByWeb2Identity(web2identity) {
        const normalized = normalizePhoneLabel(web2identity);
        if (!normalized) return null;
        logMappingConfig();

        const ansPayload = await fetchJsonWithBearer(
            GCP_ANS_MAPPING_URL,
            { web2identity: normalized },
            `ans-mapping:${normalized}`,
        );
        const ansWallet = checksumWalletOrNull(ansPayload?.wallet);
        if (ansWallet) {
            logger.log("[IdentityMapping] wallet selected", {
                web2identity: normalized,
                walletSource: "gcp_ans_wallet",
                wallet: ansWallet,
            });
            return ansWallet;
        }

        const web3identity = String(ansPayload?.web3identity || "").trim();
        if (!web3identity) {
            logger.log("[IdentityMapping] fallback reason", {
                web2identity: normalized,
                reason: "missing_web3identity_or_wallet",
            });
            return null;
        }

        const web3Payload = await fetchJsonWithBearer(
            GCP_WEB3_IDENTITY_MAPPING_URL,
            { web3identity },
            `web3-identity-mapping:${web3identity}`,
        );
        const web3Wallet = checksumWalletOrNull(web3Payload?.wallet);
        if (web3Wallet) {
            logger.log("[IdentityMapping] wallet selected", {
                web2identity: normalized,
                web3identity,
                walletSource: "gcp_web3_wallet",
                wallet: web3Wallet,
            });
            return web3Wallet;
        }
        logger.log("[IdentityMapping] fallback reason", {
            web2identity: normalized,
            web3identity,
            reason: "missing_wallet",
        });
        return null;
    }

    // Some clients (Android SDK envelope signing) double-prefix the hex sig as
    // "0x0x...". Collapse repeated leading 0x so verifyMessage can parse it.
    function normalizeSignature(sig) {
        let s = String(sig || "").trim();
        while (/^0x0x/i.test(s)) {
            s = s.slice(2);
        }
        return s;
    }

    function normalizeEnsDomain(ens) {
        if (!providerPolicy || typeof providerPolicy.normalizeEnsDomain !== "function") {
            return String(ens || "");
        }
        return providerPolicy.normalizeEnsDomain(ens);
    }

    function identityLabel(identity) {
        if (!identity || typeof identity !== "string") return identity;
        const trimmed = identity.trim();
        const atPos = trimmed.indexOf("@");
        if (atPos > 0) return trimmed.slice(0, atPos);
        const dotPos = trimmed.indexOf(".");
        if (dotPos > 0) return trimmed.slice(0, dotPos);
        return trimmed;
    }

    function sameIdentityLabel(left, right) {
        return identityLabel(String(left || "").toLowerCase()) ===
            identityLabel(String(right || "").toLowerCase());
    }

    function namehash(name) {
        if (!name) return "0x0000000000000000000000000000000000000000000000000000000000000000";
        const labels = name.split(".");
        let node = "0x0000000000000000000000000000000000000000000000000000000000000000";
        for (let i = labels.length - 1; i >= 0; i--) {
            const labelHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(labels[i]));
            node = ethers.utils.keccak256(ethers.utils.solidityPack(["bytes32", "bytes32"], [node, labelHash]));
        }
        return node;
    }

    async function resolveEnsToOwner(ensName) {
        const fullName = ensName.endsWith(".global") ? ensName : `${ensName}.global`;
        const provider = getPolygonProvider();
        const node = namehash(fullName);
        const ensRegistry = new ethers.Contract(ENS_REGISTRY_ADDRESS, ENS_REGISTRY_ABI, provider);
        const nameWrapper = new ethers.Contract(NAME_WRAPPER_ADDRESS, NAME_WRAPPER_ABI, provider);
        const ensOwner = await ensRegistry.owner(node);
        if (ensOwner.toLowerCase() === NAME_WRAPPER_ADDRESS.toLowerCase()) {
            return nameWrapper.ownerOf(node);
        }
        return ensOwner;
    }

    async function resolveEnsToAddress(ensName) {
        const fullName = ensName.endsWith(".global") ? ensName : `${ensName}.global`;
        const provider = getPolygonProvider();
        const node = namehash(fullName);
        const ensRegistry = new ethers.Contract(ENS_REGISTRY_ADDRESS, ENS_REGISTRY_ABI, provider);
        try {
            const resolverAddr = await ensRegistry.resolver(node);
            if (resolverAddr && resolverAddr !== ethers.constants.AddressZero) {
                const resolver = new ethers.Contract(resolverAddr, ENS_PUBLIC_RESOLVER_ABI, provider);
                const addr = await resolver.addr(node);
                if (addr && addr !== ethers.constants.AddressZero) return addr;
            }
        } catch (err) {
            logger.log(`[ENS] resolver.addr() failed for ${fullName}: ${err.message}, falling back to owner`);
        }
        return resolveEnsToOwner(ensName);
    }

    async function resolveEnsTextRecord(ensName, key) {
        const fullName = ensName.endsWith(".global") ? ensName : `${ensName}.global`;
        const provider = getPolygonProvider();
        const node = namehash(fullName);
        const ensRegistry = new ethers.Contract(ENS_REGISTRY_ADDRESS, ENS_REGISTRY_ABI, provider);
        const resolverAddr = await ensRegistry.resolver(node);
        if (!resolverAddr || resolverAddr === ethers.constants.AddressZero) {
            return null;
        }
        const resolver = new ethers.Contract(resolverAddr, ENS_PUBLIC_RESOLVER_ABI, provider);
        try {
            const value = await resolver.text(node, key);
            return value || null;
        } catch (_) {
            return null;
        }
    }

    async function resolveWrappedOwner(ensName) {
        const fullName = ensName.endsWith(".global") ? ensName : `${ensName}.global`;
        const provider = getPolygonProvider();
        const node = namehash(fullName);
        const nameWrapper = new ethers.Contract(NAME_WRAPPER_ADDRESS, NAME_WRAPPER_ABI, provider);
        return nameWrapper.ownerOf(node);
    }

    async function verifyInitialOfferSignature(offer) {
        const from = normalizeEnsDomain(offer.from || "");
        const { xdata, xsign, sessionId } = offer;
        if (!from) throw createHttpError(400, "Missing required field: from");
        if (!xdata) throw createHttpError(401, "Missing required field: xdata");
        if (!xsign) throw createHttpError(401, "Missing required field: xsign");

        logger.log(`[${sessionId || "no-session"}] From: ${from}`);
        logger.log(`[${sessionId || "no-session"}] X sign: ${xsign}, X data: ${xdata}`);

        const expectedSigner = await resolveExpectedSigner(from);

        let recoveredSigner;
        try {
            recoveredSigner = ethers.utils.getAddress(
                ethers.utils.verifyMessage(String(xdata), normalizeSignature(xsign)),
            );
        } catch (err) {
            throw createHttpError(401, `Invalid xsign for xdata: ${err.message}`);
        }
        if (recoveredSigner !== expectedSigner) {
            throw createHttpError(403, `xsign signer mismatch for ${from}: expected ${expectedSigner}, got ${recoveredSigner}`);
        }
        logger.log(`[${sessionId || "no-session"}] Initial offer signature verified for ${from} (${recoveredSigner})`);
    }

    async function verifyParticipantSignature(message) {
        const from = normalizeEnsDomain(message.from || "");
        const { xdata, xsign, sessionId, type } = message;
        if (!from) throw createHttpError(400, "Missing required field: from");
        if (!xdata) throw createHttpError(401, "Missing required field: xdata");
        if (!xsign) throw createHttpError(401, "Missing required field: xsign");

        const expectedSigner = await resolveExpectedSigner(from);
        let recoveredSigner;
        try {
            recoveredSigner = ethers.utils.getAddress(
                ethers.utils.verifyMessage(String(xdata), normalizeSignature(xsign)),
            );
        } catch (err) {
            throw createHttpError(401, `Invalid xsign for xdata: ${err.message}`);
        }
        if (recoveredSigner !== expectedSigner) {
            throw createHttpError(403, `xsign signer mismatch for ${from}: expected ${expectedSigner}, got ${recoveredSigner}`);
        }
        logger.log(`[${sessionId || "no-session"}] ${type || "participant"} signature verified for ${from} (${recoveredSigner})`);
    }

    async function resolveExpectedSigner(identity) {
        if (isEthAddress(identity)) {
            return ethers.utils.getAddress(identity);
        }
        const web2identity = deriveWeb2Identity(identity);
        if (web2identity) {
            const mappedWallet = await resolveWalletByWeb2Identity(web2identity);
            if (mappedWallet) {
                logger.log(`[Auth] signer source=gcp web2identity=${web2identity} wallet=${mappedWallet}`);
                return mappedWallet;
            }
            logger.log(`[Auth] signer fallback=ens identity=${identity} web2identity=${web2identity}`);
        }
        let wrappedOwner;
        try {
            wrappedOwner = await resolveWrappedOwner(identity);
        } catch (err) {
            throw createHttpError(401, `Failed resolving wrapped owner for ${identity}: ${err.message}`);
        }
        if (!wrappedOwner || wrappedOwner === ethers.constants.AddressZero) {
            throw createHttpError(401, `Wrapped owner not found for ${identity}`);
        }
        return ethers.utils.getAddress(wrappedOwner);
    }

    async function verifyAnswerSignature(offer, session) {
        const { sessionId, xdata, xsign } = offer;
        if (!session) throw createHttpError(404, "Session not found for answer verification");
        if (!xdata) throw createHttpError(401, "Missing required field: xdata");
        if (!xsign) throw createHttpError(401, "Missing required field: xsign");

        const offeredFrom = normalizeEnsDomain(offer.from || "");
        let expectedIdentity = normalizeEnsDomain(session.outboundWebrtc?.toIdentity || session.toIdentity || "");
        if (session.outboundWebrtcLegs?.values && offeredFrom) {
            for (const leg of session.outboundWebrtcLegs.values()) {
                const legIdentity = normalizeEnsDomain(leg.toIdentity || "");
                if (legIdentity && legIdentity === offeredFrom) {
                    expectedIdentity = legIdentity;
                    break;
                }
            }
        }
        if (!expectedIdentity) {
            throw createHttpError(401, "Unable to verify answer signer: missing session toIdentity");
        }

        if (offeredFrom && !sameIdentityLabel(offeredFrom, expectedIdentity)) {
            throw createHttpError(403, `Answer 'from' mismatch: expected ${expectedIdentity}, got ${offeredFrom}`);
        }

        const verificationIdentity = offeredFrom || expectedIdentity;
        const expectedSigner = await resolveExpectedSigner(verificationIdentity);
        let recoveredSigner;
        try {
            recoveredSigner = ethers.utils.getAddress(
                ethers.utils.verifyMessage(String(xdata), normalizeSignature(xsign)),
            );
        } catch (err) {
            throw createHttpError(401, `Invalid xsign for xdata: ${err.message}`);
        }
        if (recoveredSigner !== expectedSigner) {
            throw createHttpError(
                403,
                `Answer xsign signer mismatch for ${verificationIdentity}: expected ${expectedSigner}, got ${recoveredSigner}`,
            );
        }
        logger.log(`[${sessionId || "no-session"}] Answer signature verified for ${verificationIdentity} (${recoveredSigner})`);
    }

    function getRpcForNetwork(networkName) {
        switch (String(networkName || "polygon").toLowerCase()) {
            case "sapphire":
            case "oasis_sapphire":
                return SAPPHIRE_RPC;
            case "polygon":
            default:
                return POLYGON_RPC;
        }
    }

    async function resolveCallerServiceProviderContract(callerEns) {
        if (isEthAddress(callerEns)) return null;
        callerEns = normalizeEnsDomain(callerEns);
        const normalizedCallerEns = String(callerEns || "").trim().toLowerCase();
        const callerDomain = normalizedCallerEns.includes(".")
            ? normalizedCallerEns.split(".").slice(1).join(".")
            : "";
        const useHardcodedProvider = Boolean(
            NOTIFICATION_PROVIDER_ADDRESS
            && (NOTIFICATION_PROVIDER_APPLY_ALL || SECNUM_DOMAINS.has(callerDomain)),
        );
        if (useHardcodedProvider) {
            logger.log("[NotificationProvider] using hardcoded provider", {
                callerEns: normalizedCallerEns || null,
                callerDomain: callerDomain || null,
                notificationRegistryAddress: NOTIFICATION_PROVIDER_ADDRESS,
                source: "hardcoded",
            });
            return {
                notificationRegistryAddress: NOTIFICATION_PROVIDER_ADDRESS,
                networkName: "polygon",
                rpcUrl: POLYGON_RPC,
                isDefault: true,
            };
        }
        const provider = getPolygonProvider();
        const spr = new ethers.Contract(SERVICE_PROVIDER_REGISTRY_ADDRESS, SERVICE_PROVIDER_REGISTRY_ABI, provider);
        let serviceRegistryAddress;
        try {
            serviceRegistryAddress = await spr.serviceRegistry();
        } catch (err) {
            logger.error(`[SPResolver] serviceRegistry() failed: ${err.message}`);
            return null;
        }
        if (!serviceRegistryAddress || serviceRegistryAddress === ethers.constants.AddressZero) return null;
        const serviceRegistry = new ethers.Contract(serviceRegistryAddress, SERVICE_REGISTRY_ABI, provider);
        const fullCaller = callerEns.endsWith(".global") ? callerEns : `${callerEns}.global`;
        let currentDomain = fullCaller;
        while (currentDomain && currentDomain.includes(".")) {
            const node = namehash(currentDomain);
            try {
                const contractAddr = await serviceRegistry.getServiceContract(node);
                if (contractAddr && contractAddr !== ethers.constants.AddressZero) {
                    return {
                        notificationRegistryAddress: contractAddr,
                        networkName: "polygon",
                        rpcUrl: POLYGON_RPC,
                        isDefault: false,
                    };
                }
            } catch (_) {}
            const dotIndex = currentDomain.indexOf(".");
            if (dotIndex >= 0) currentDomain = currentDomain.substring(dotIndex + 1);
            else break;
        }
        return null;
    }

    function getNftCallerIdPool() {
        const provider = getSapphireTestnetProvider();
        return new ethers.Contract(NFT_CALLER_ID_POOL_ADDRESS, NFT_CALLER_ID_POOL_ABI, provider);
    }

    async function nftGetOwnedNumber(walletAddress) {
        try {
            const pool = getNftCallerIdPool();
            const balance = await pool.balanceOf(walletAddress);
            if (balance.lte(0)) return null;
            const tokenId = await pool.tokenOfOwnerByIndex(walletAddress, 0);
            const [phoneNumber] = await pool.getCallerIdByTokenId(tokenId);
            return phoneNumber || null;
        } catch (err) {
            logger.error(`[NFT] getOwnedNumber failed for ${walletAddress}: ${err.message}`);
            return null;
        }
    }

    async function roflFindBusinessNumber(callee) {
        const contract = getBusinessNumberDbContract();
        if (!contract) return null;

        const businessName = String(callee || "").trim().toLowerCase();
        if (!businessName) return null;
        try {
            const phoneNumber = await contract.getPhoneNumber(businessName);
            const result = phoneNumber && phoneNumber !== "" ? phoneNumber : null;
            logger.log(`[ROFL_LOCAL] business lookup ${businessName} -> ${result || "no-match"}`);
            return result;
        } catch (err) {
            logger.error(`[ROFL_LOCAL] find-business-number failed for ${businessName}: ${err.message}`);
            return null;
        }
    }

    async function roflAssignFromNumber() {
        const pool = getRoflCallerIdPoolContract();
        if (!pool) return null;

        try {
            const poolSize = await pool.getPoolSize();
            if (toSafeNumber(poolSize) <= 0) return null;

            const roflKeyAddress = getRoflAddress();

            // Explicit request: if PKEY is not set, assign directly from pool
            // without owner filtering (pure round-robin by token list index).
            if (!roflKeyAddress) {
                const idx = roflCallerIdIndex % toSafeNumber(poolSize);
                const tokenId = await pool.tokenByIndex(idx);
                const [fromNumber] = await pool.getCallerIdByTokenId(tokenId);
                if (!fromNumber || fromNumber === "") return null;

                roflCallerIdIndex = idx + 1;
                return fromNumber;
            }

            const ownerForPool = (await getRoflPoolOwnerAddress()) || roflKeyAddress;
            if (!ownerForPool) return null;

            const [fromNumber, foundIndex, found] = await pool.findNextOwnedCallerId(
                ethers.BigNumber.from(roflCallerIdIndex),
                ownerForPool,
                poolSize,
            );

            if (!found || !fromNumber || fromNumber === "") return null;
            roflCallerIdIndex = toSafeNumber(foundIndex, roflCallerIdIndex) + 1;
            return fromNumber;
        } catch (err) {
            logger.error(`[ROFL_LOCAL] assign-from-number failed: ${err.message}`);
            return null;
        }
    }

    function getRoflLogicInfo() {
        return {
            rpc: ROFL_LOGIC_RPC || null,
            chainId: ROFL_LOGIC_CHAIN_ID || null,
            businessNumberDbRpc: ROFL_BUSINESS_NUMBER_DB_RPC || null,
            businessNumberDbChainId: ROFL_BUSINESS_NUMBER_DB_CHAIN_ID || null,
            businessNumberDbAddress: normalizeContractAddress(ROFL_BUSINESS_NUMBER_DB_ADDRESS) || null,
            callerIdPoolRpc: ROFL_CALLER_ID_POOL_RPC || null,
            callerIdPoolChainId: ROFL_CALLER_ID_POOL_CHAIN_ID || null,
            callerIdPoolAddress: normalizeContractAddress(ROFL_CALLER_ID_POOL_ADDRESS) || null,
            roflAddress: getRoflAddress() || null,
        };
    }

    return {
        ethers,
        getPolygonProvider,
        getSapphireProvider,
        getSapphireTestnetProvider,
        isEthAddress,
        normalizeEnsDomain,
        namehash,
        resolveEnsToOwner,
        resolveEnsToAddress,
        resolveEnsTextRecord,
        resolveWrappedOwner,
        resolveWalletByWeb2Identity,
        verifyInitialOfferSignature,
        verifyParticipantSignature,
        verifyAnswerSignature,
        resolveCallerServiceProviderContract,
        nftGetOwnedNumber,
        roflFindBusinessNumber,
        roflAssignFromNumber,
        getRoflLogicInfo,
        getRpcForNetwork,
    };
}

module.exports = {
    createBlockchainApi,
};
