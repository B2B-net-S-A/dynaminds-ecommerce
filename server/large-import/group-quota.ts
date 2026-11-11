/** Same original request's real installed44 group broker. No scalar fallback performance claim. */
import assert from'node:assert/strict';import type{Actor}from'../domain';import type{FastifyRequest}from'fastify';
import{createNativeResourceGroupBroker,attachNativeResourceGroups}from'../../shared/large-import-dependencies/pim-large-import173-bounded-native-groups-backend/groups';
import type{Ports}from'../../shared/large-import-dependencies/pim-large-import173-composed-runtime-backend/transport';import type{OwnedRequest}from'../../shared/large-import-dependencies/pim-large-import-upload-quota-broker-backend3/broker';
export function withOriginalResourceGroups<T extends {unknown():Promise<void>;snapshot():Promise<any>}>(ports:Ports,original:FastifyRequest,expected:Actor,owned:OwnedRequest,native:T){
 const broker=createNativeResourceGroupBroker({...ports}),actor=broker.capture(original);assert.deepEqual({t:actor.tenantId,u:actor.userId,k:actor.apiKeyId??null,r:actor.role},{t:expected.tenantId,u:expected.userId,k:expected.apiKeyId??null,r:expected.role});
 return attachNativeResourceGroups(native,broker.bind(actor,structuredClone(owned)));
}
