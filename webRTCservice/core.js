"use strict";

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
    createSessionStore: require("./modules/sessionStore").createSessionStore,
    createHttpServers: require("./modules/httpServer").createHttpServers,
    createPublicServer: require("./modules/httpServer").createPublicServer,
    createInternalServer: require("./modules/httpServer").createInternalServer,
    createHandlers: require("./modules/handlers").createHandlers,
    createSignalingPipeline: require("./modules/signalingPipeline").createSignalingPipeline,
    corePath: path.join(__dirname),
};
