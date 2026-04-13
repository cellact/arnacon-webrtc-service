"use strict";

const { ethers } = require("ethers");

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

    let polygonProvider = null;
    let sapphireProvider = null;
    let sapphireTestnetProvider = null;

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

    function isEthAddress(str) {
        return /^0x[0-9a-fA-F]{40}$/.test(str);
    }

    function normalizeEnsDomain(ens) {
        if (!providerPolicy || typeof providerPolicy.normalizeEnsDomain !== "function") {
            return String(ens || "");
        }
        return providerPolicy.normalizeEnsDomain(ens);
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
                ethers.utils.verifyMessage(String(xdata), String(xsign)),
            );
        } catch (err) {
            throw createHttpError(401, `Invalid xsign for xdata: ${err.message}`);
        }
        if (recoveredSigner !== expectedSigner) {
            throw createHttpError(403, `xsign signer mismatch for ${from}: expected ${expectedSigner}, got ${recoveredSigner}`);
        }
        logger.log(`[${sessionId || "no-session"}] Initial offer signature verified for ${from} (${recoveredSigner})`);
    }

    async function resolveExpectedSigner(identity) {
        if (isEthAddress(identity)) {
            return ethers.utils.getAddress(identity);
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

        const expectedIdentity = normalizeEnsDomain(session.toIdentity || "");
        if (!expectedIdentity) {
            throw createHttpError(401, "Unable to verify answer signer: missing session toIdentity");
        }

        const from = normalizeEnsDomain(offer.from || "");
        if (from && from !== expectedIdentity) {
            throw createHttpError(403, `Answer 'from' mismatch: expected ${expectedIdentity}, got ${from}`);
        }

        const expectedSigner = await resolveExpectedSigner(expectedIdentity);
        let recoveredSigner;
        try {
            recoveredSigner = ethers.utils.getAddress(
                ethers.utils.verifyMessage(String(xdata), String(xsign)),
            );
        } catch (err) {
            throw createHttpError(401, `Invalid xsign for xdata: ${err.message}`);
        }
        if (recoveredSigner !== expectedSigner) {
            throw createHttpError(
                403,
                `Answer xsign signer mismatch for ${expectedIdentity}: expected ${expectedSigner}, got ${recoveredSigner}`,
            );
        }
        logger.log(`[${sessionId || "no-session"}] Answer signature verified for ${expectedIdentity} (${recoveredSigner})`);
    }

    async function verifyHttpSignalingSignature(payload) {
        const notifyType = payload?.type || "offer";
        await verifyInitialOfferSignature(payload || {});
        logger.log(
            `[${payload?.sessionId || "no-session"}] HTTP signaling signature verified (type=${notifyType})`,
        );
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
        verifyInitialOfferSignature,
        verifyAnswerSignature,
        verifyHttpSignalingSignature,
        resolveCallerServiceProviderContract,
        nftGetOwnedNumber,
        getRpcForNetwork,
    };
}

module.exports = {
    createBlockchainApi,
};
