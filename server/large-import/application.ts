/** Application-owned entrypoint. Caller cannot supply an unwrapped runtimeFactory or JSON readiness. */
export {createRegisteredLargeImportApplication as createLargeImportApplication} from './runtime-registration';
export type {RegistrationPorts as NativeDrivers} from './runtime-registration';
