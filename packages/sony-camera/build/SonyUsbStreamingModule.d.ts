import { NativeModule } from 'expo';
import type { SonyPhoto, SonyUsbStreamingDiagnostics, SonyUsbStreamingModuleEvents, SonyUsbStreamingState } from './SonyCamera.types';
declare class SonyUsbStreamingNativeModule extends NativeModule<SonyUsbStreamingModuleEvents> {
    getState(): SonyUsbStreamingState;
    getDiagnostics(): SonyUsbStreamingDiagnostics;
    clearDiagnostics(): void;
    startStreaming(): Promise<SonyUsbStreamingState>;
    stopStreaming(): Promise<SonyUsbStreamingState>;
    /** Implemented on iOS. Android callers must treat this as unsupported in 0.2.0. */
    capturePreviewFrame(): Promise<SonyPhoto>;
}
declare const _default: SonyUsbStreamingNativeModule | null;
export default _default;
//# sourceMappingURL=SonyUsbStreamingModule.d.ts.map