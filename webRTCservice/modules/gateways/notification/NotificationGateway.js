class NotificationGateway {
    constructor({ notificationApi, logger = console } = {}) {
        if (!notificationApi) throw new Error("NotificationGateway requires notificationApi");
        this.notificationApi = notificationApi;
        this.logger = logger;
    }

    send(callerEns, calleeEns, message, notificationType, options) {
        return this.notificationApi.sendNotification(callerEns, calleeEns, message, notificationType, options);
    }

    resolvePlan(callerEns, calleeEns, message, notificationType, options) {
        return this.notificationApi.resolveNotificationPlan(callerEns, calleeEns, message, notificationType, options);
    }

    executePlan(steps, options) {
        return this.notificationApi.executeNotificationPlan(steps, options);
    }
}

module.exports = {
    NotificationGateway,
};
