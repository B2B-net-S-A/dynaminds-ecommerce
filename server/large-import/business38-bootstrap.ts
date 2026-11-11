/** Explicit Root/application construction only. Import does not open a connection, create an Actor, start an app or mint readiness. */
import {createReviewedStartup,inspectCompositeStartup,recheckReviewedStartupEvidence,type CompositeCompileInput,type OwnerReader} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/api';
import {createRegisteredLargeImportApplication,type RegistrationPorts} from './runtime-registration';
import {createAcceptedInternalBusinessEngine,type CompositionPorts} from '../../shared/large-import-dependencies/pim-large-import-business-native-proof-ui/composition';

export type ReviewedEvidenceOptions=NonNullable<Parameters<typeof createReviewedStartup>[1]>;
export type ApplicationInput={reviewedEvidenceOptions?:ReviewedEvidenceOptions;compile:CompositeCompileInput;drivers:Omit<RegistrationPorts,'startup'>|undefined;readOnly:boolean};
/** Only independently reviewed NEW38 compile evidence can mint the handle shared by every actual consumer. Missing real native-hook proof keeps routes unavailable. */
export async function createReviewedBusinessApplication(input:ApplicationInput){
 const evidenceOptions=structuredClone(input.reviewedEvidenceOptions??{});
 const compile=structuredClone(input.compile),readOnly=input.readOnly;
 const captured=input.drivers===undefined?undefined:{...input.drivers,transport:{...input.drivers.transport},reader:{...input.drivers.reader}};
 const startup=await createReviewedStartup(compile,evidenceOptions);
 const application=await createRegisteredLargeImportApplication(captured===undefined?undefined:{...captured,startup},readOnly);
 return{startup,recheckStartupEvidence:()=>recheckReviewedStartupEvidence(startup),application,activation:'REQUIRES_GENUINE_ALL_HOOKS_AND_BUSINESS_UI_ACCEPTANCE' as const};
}
export type InternalInput=Omit<Parameters<typeof createAcceptedInternalBusinessEngine>[0],'transport'|'keeper'>&{
 reviewedEvidenceOptions?:ReviewedEvidenceOptions;
 compile:CompositeCompileInput;
 transport:Omit<CompositionPorts['transport'],'preflightOwner173'>;
 keeper:Omit<CompositionPorts['keeper'],'transport'>&{transport:Omit<CompositionPorts['keeper']['transport'],'preflightOwner173'>};
};
/** Separate internal native-proof lane: it cannot manufacture public registry proof or invoke product actions on construction. */
export async function createReviewedInternalBusinessEngine(input:InternalInput){
 const evidenceOptions=structuredClone(input.reviewedEvidenceOptions??{});
 const compile=structuredClone(input.compile),captured={...input,transport:{...input.transport},keeper:{...input.keeper,transport:{...input.keeper.transport}},firstPhase:structuredClone(input.firstPhase)};
 const startup=await createReviewedStartup(compile,evidenceOptions);
 const preflightOwner173=async(c:Parameters<CompositionPorts['transport']['preflightOwner173']>[0])=>{await inspectCompositeStartup(c as OwnerReader,startup);return'VALID' as const;};
 const admitted=await createAcceptedInternalBusinessEngine({...captured,transport:{...captured.transport,preflightOwner173},keeper:{...captured.keeper,transport:{...captured.keeper.transport,preflightOwner173}}});
 return{startup,recheckStartupEvidence:()=>recheckReviewedStartupEvidence(startup),...admitted,public_application_ready:false as const};
}
