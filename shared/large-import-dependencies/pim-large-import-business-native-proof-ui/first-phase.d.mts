export type Ref={path:string;sha256:string};
export type AcceptedPhysicalPhase={result:Ref;peer:Ref;database:string;baseline:Ref;retained:unknown;public_application_ready:false};
export function sha(x:string|Uint8Array):string;
export function privateJson(ref:Ref):Promise<unknown>;
export function admitClosedPhysicalPhase(resultRef:Ref,peerRef:Ref):Promise<AcceptedPhysicalPhase>;
