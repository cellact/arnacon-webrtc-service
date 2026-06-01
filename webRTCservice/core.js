const path = require("path");

function startServiceProcess({
    serviceId,
    deployEnv = process.env.DEPLOY_ENV || "development",
} = {}) {
    if (!serviceId) {
        throw new Error("startServiceProcess requires serviceId");
    }
    process.env.DEPLOY_ENV = deployEnv;
    process.env.SERVICE_ID = serviceId;
    return require("./webRTCmanager");
}

module.exports = {
    startServiceProcess,
    createSessionStore: require("./modules/runtime/SessionStore").createSessionStore,
    createHttpServers: require("./modules/server/HttpServer").createHttpServers,
    createPublicServer: require("./modules/server/HttpServer").createPublicServer,
    createInternalServer: require("./modules/server/HttpServer").createInternalServer,
    createHandlers: require("./modules/server/HttpHandlers").createHandlers,
    createSignalingPipeline: require("./modules/participants/signaling/SignalingPipeline").createSignalingPipeline,
    corePath: path.join(__dirname),
};
