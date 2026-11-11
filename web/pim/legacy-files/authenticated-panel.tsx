/** The committed import catalog is authoritative; the surrounding list filter is unrelated. */
import {useMemo,useRef} from 'react';
import {CorePimContinuation,type ContinuationProps} from './panel';
import {coreRequest} from './handoff';
import {createAuthenticatedLegacyStagePort} from './stage-transport';

export type AuthenticatedContinuationProps = Omit<ContinuationProps,'stagePort'> & {
  stageReady:boolean;
  canStage:()=>boolean;
};

export function AuthenticatedCorePimContinuation(props:AuthenticatedContinuationProps){
  const latest = useRef(props.canStage);
  latest.current = props.canStage;
  const catalogId = useMemo(() => coreRequest(props.custody.serialized_request).catalog_id as string,
    [props.custody.serialized_request]);
  const port = useMemo(() => createAuthenticatedLegacyStagePort(props.transport,catalogId,() => latest.current()),
    [props.transport,catalogId]);
  if(!props.stageReady)return <p className="notice">Import zapisany. Drugi etap mapowania PIM wymaga podłączonego adaptera trwałego wyniku; nie wykonano zapisu parametrów.</p>;
  return <CorePimContinuation context={props.context} custody={props.custody} transport={props.transport}
    stagePort={port} nestedMappingAvailable={props.nestedMappingAvailable} externalWriteBlocked={props.externalWriteBlocked} onChanged={props.onChanged}/>;
}
