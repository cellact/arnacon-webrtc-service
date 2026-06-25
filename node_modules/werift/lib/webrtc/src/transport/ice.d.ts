import { Event } from "../imports/common";
import { Candidate, type IceConnection, type IceOptions } from "../../../ice/src";
import { type RTCStats } from "../media/stats";
/**
 *                                          +------------+
                                            |            |
                                            |disconnected|
                                            |            |
                                            +------------+
                                            ^           ^
                                            |           |
+------+      +----------+      +-----------+      +----------+
|      |      |          |      |           |      |          |
| new  | ---> | checking | ---> | connected | ---> | completed|
|      |      |          |      |           |      |          |
+------+      +----+-----+      +-----------+      +----------+
                    |
                    |
                    v
                +-------+
                |       |
                | failed|
                |       |
                +-------+
 */
export declare class RTCIceTransport {
    private iceGather;
    readonly id: string;
    connection: IceConnection;
    state: RTCIceConnectionState;
    private waitStart?;
    private renominating;
    readonly onStateChange: Event<["disconnected" | "closed" | "completed" | "new" | "connected" | "failed" | "checking"]>;
    readonly onIceCandidate: Event<[IceCandidate | undefined]>;
    readonly onNegotiationNeeded: Event<[]>;
    constructor(iceGather: RTCIceGatherer);
    get role(): "controlling" | "controlled";
    get gatheringState(): "complete" | "new" | "gathering";
    get localCandidates(): IceCandidate[];
    get localParameters(): RTCIceParameters;
    private setState;
    gather(): Promise<void>;
    addRemoteCandidate: (candidate?: IceCandidate) => Promise<void> | undefined;
    setRemoteParams(remoteParameters: RTCIceParameters, renomination?: boolean): void;
    restart(): void;
    start(): Promise<void>;
    stop(): Promise<void>;
    getStats(): Promise<RTCStats[]>;
}
export declare const IceTransportStates: readonly ["new", "checking", "connected", "completed", "disconnected", "failed", "closed"];
export type RTCIceConnectionState = (typeof IceTransportStates)[number];
export declare const IceGathererStates: readonly ["new", "gathering", "complete"];
export type IceGathererState = (typeof IceGathererStates)[number];
export declare class RTCIceGatherer {
    private options;
    onIceCandidate: (candidate: IceCandidate | undefined) => void;
    gatheringState: IceGathererState;
    readonly connection: IceConnection;
    readonly onGatheringStateChange: Event<["complete" | "new" | "gathering"]>;
    constructor(options?: Partial<IceOptions>);
    gather(): Promise<void>;
    get localCandidates(): IceCandidate[];
    get localParameters(): RTCIceParameters;
    private setState;
}
export declare function candidateFromIce(c: Candidate): IceCandidate;
export declare function candidateToIce(x: IceCandidate): Candidate;
export interface RTCIceCandidateInit {
    candidate?: string;
    sdpMLineIndex?: number | null;
    sdpMid?: string | null;
    usernameFragment?: string | null;
}
export declare class RTCIceCandidate {
    candidate: string;
    sdpMid?: string;
    sdpMLineIndex?: number;
    usernameFragment?: string;
    constructor(props: Partial<RTCIceCandidate>);
    static fromSdp(sdp: string): RTCIceCandidate;
    static isThis(o: any): true | undefined;
    toJSON(): {
        candidate: string;
        sdpMid: string | undefined;
        sdpMLineIndex: number | undefined;
        usernameFragment: string | undefined;
    };
}
export declare class IceCandidate {
    component: number;
    foundation: string;
    ip: string;
    port: number;
    priority: number;
    protocol: string;
    type: string;
    generation?: number | undefined;
    ufrag?: string | undefined;
    relatedAddress?: string;
    relatedPort?: number;
    sdpMid?: string;
    sdpMLineIndex?: number;
    tcpType?: string;
    constructor(component: number, foundation: string, ip: string, port: number, priority: number, protocol: string, type: string, generation?: number | undefined, ufrag?: string | undefined);
    toJSON(): RTCIceCandidate;
    static fromJSON(data: RTCIceCandidate | RTCIceCandidateInit): IceCandidate | undefined;
}
export declare class RTCIceParameters {
    iceLite: boolean;
    usernameFragment: string;
    password: string;
    constructor(props?: Partial<RTCIceParameters>);
}
