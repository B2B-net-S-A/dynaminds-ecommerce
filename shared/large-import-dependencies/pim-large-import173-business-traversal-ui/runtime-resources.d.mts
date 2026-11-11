import type {Buffer} from 'node:buffer';
declare const resourceBrand: unique symbol;
export type RuntimeResourceReader={readonly [resourceBrand]:true};
export type RuntimeResourceSelection={releaseDirectory:string;manifestSha:string};
export declare const RESOURCE_DEFINITIONS:ReadonlyArray<Readonly<{id:string;source:string;path:string;consumer:string}>>;
export declare function createInstalledRuntimeResourceReader(input:RuntimeResourceSelection):Promise<RuntimeResourceReader>;
export declare function readInstalledRuntimeResource(reader:RuntimeResourceReader,id:string,consumerUrl:string):Promise<Buffer>;
export declare function installRuntimeResources(input:RuntimeResourceSelection):Promise<void>;
export declare function readRuntimeResource(id:string,consumerUrl:string):Promise<Buffer>;
