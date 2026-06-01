class NotificationGateway {
    constructor({ notificationApi, logger = console } = {}) {
        if (!notificationApi) throw new Error("NotificationGateway requires notificationApi");
        this.notificationApi = notificationApi;
        this.logger = logger;
    }

    send(callerEns, calleeEns, message, notificationType) {
        return this.notificationApi.sendNotification(callerEns, calleeEns, message, notificationType);
    }

    resolvePlan(callerEns, calleeEns, message, notificationType) {
        return this.notificationApi.resolveNotificationPlan(callerEns, calleeEns, message, notificationType);
    }

    executePlan(steps) {
        return this.notificationApi.executeNotificationPlan(steps);
    }
}

module.exports = {
    NotificationGateway,
};
