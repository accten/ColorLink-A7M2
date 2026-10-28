import { NativeModule } from 'expo';
import type { SonyCameraModuleEvents, SonyConnectOptions, SonyDiagnosticsSnapshot, SonyFocusResult, SonyCameraState, SonyPhoto } from './SonyCamera.types';
declare class SonyCameraNativeModule extends NativeModule<SonyCameraModuleEvents> {
    getState(): SonyCameraState;
    connect(options?: SonyConnectOptions): Promise<SonyCameraState>;
    disconnect(): Promise<SonyCameraState>;
    startLiveView(): Promise<SonyCameraState>;
    stopLiveView(): Promise<SonyCameraState>;
    capturePhoto(): Promise<SonyPhoto>;
    /**
     * Persists the most recent live-view frame without triggering the shutter.
     *
     * This is a preview-resolution still, not a full capture, and it rejects when no frame
     * has arrived yet. It does not emit `onPhotoCaptured`.
     */
    capturePreviewFrame(): Promise<SonyPhoto>;
    /** 诊断：直接发一条 Sony 厂商操作（逆向取图协议用） */
    probeVendorOp?(operation: number, params?: number[], dataHex?: string): Promise<Record<string, unknown>>;
    /** Android only, and only when the active ScalarWebAPI camera advertises coordinate focus. */
    focusAt?(x: number, y: number, viewWidth: number, viewHeight: number): Promise<SonyFocusResult>;
    getDiagnostics(): SonyDiagnosticsSnapshot;
    clearDiagnostics(): void;
}
declare const _default: SonyCameraNativeModule | null;
export default _default;
//# sourceMappingURL=SonyCameraModule.d.ts.map