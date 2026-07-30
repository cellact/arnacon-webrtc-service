class BlockchainGateway {
    constructor({ blockchainApi }) {
        if (!blockchainApi) throw new Error("BlockchainGateway requires blockchainApi");
        this.blockchainApi = blockchainApi;
    }

    resolveEnsToAddress(...args) {
        return this.blockchainApi.resolveEnsToAddress(...args);
    }

    resolveEnsToOwner(...args) {
        return this.blockchainApi.resolveEnsToOwner(...args);
    }

    resolveEnsTextRecord(...args) {
        return this.blockchainApi.resolveEnsTextRecord(...args);
    }

    resolveWalletByWeb2Identity(...args) {
        return this.blockchainApi.resolveWalletByWeb2Identity(...args);
    }

    verifyInitialOfferSignature(...args) {
        return this.blockchainApi.verifyInitialOfferSignature(...args);
    }

    verifyAnswerSignature(...args) {
        return this.blockchainApi.verifyAnswerSignature(...args);
    }

    verifyParticipantSignature(...args) {
        return this.blockchainApi.verifyParticipantSignature(...args);
    }

    isEthAddress(...args) {
        return this.blockchainApi.isEthAddress(...args);
    }

    nftGetOwnedNumber(...args) {
        return this.blockchainApi.nftGetOwnedNumber(...args);
    }

    roflFindBusinessNumber(...args) {
        return this.blockchainApi.roflFindBusinessNumber(...args);
    }

    roflAssignFromNumber(...args) {
        return this.blockchainApi.roflAssignFromNumber(...args);
    }
}

module.exports = {
    BlockchainGateway,
};
