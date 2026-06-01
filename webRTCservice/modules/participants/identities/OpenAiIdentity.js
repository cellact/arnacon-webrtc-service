class OpenAiIdentity {
    constructor({ name = "openai", mode = "default", serviceId = null } = {}) {
        this.type = "openai";
        this.name = name;
        this.mode = mode;
        this.serviceId = serviceId;
    }

    label() {
        return `${this.name}:${this.mode}`;
    }
}

module.exports = {
    OpenAiIdentity,
};
