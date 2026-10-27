import type { SonyCameraCapabilities, SonyCameraInfo, SonyCameraModuleEvents, SonyCameraState, SonyFocusResult, SonyPhoto } from '../SonyCamera.types';
import type { CameraCoreCandidate, CameraCoreCapabilities, CameraCoreCommand, CameraCoreConnectRequest, CameraCoreError, CameraCorePlugin, CameraCorePluginDescriptor, CameraCorePluginSession, CameraCoreSessionState } from './CameraCoreAdapter.types';
type NativeSubscription = {
    remove(): void;
};
export interface SonyCameraNativePort {
    getState(): SonyCameraState;
    connect(options?: Record<string, unknown>): Promise<SonyCameraState>;
    disconnect(): Promise<SonyCameraState>;
    startLiveView(): Promise<SonyCameraState>;
    stopLiveView(): Promise<SonyCameraState>;
    capturePhoto(): Promise<SonyPhoto>;
    capturePreviewFrame(): Promise<SonyPhoto>;
    focusAt?(x: number, y: number, viewWidth: number, viewHeight: number): Promise<SonyFocusResult>;
    getDiagnostics(): {
        entries: string[];
        protocol?: string;
        transport?: string;
    };
    clearDiagnostics(): void;
    addListener<EventName extends keyof SonyCameraModuleEvents>(eventName: EventName, listener: SonyCameraModuleEvents[EventName]): NativeSubscription;
}
export declare function mapSonyCapabilities(capabilities: SonyCameraCapabilities | undefined, hasCoordinateFocus: boolean, revision?: number): CameraCoreCapabilities;
export declare function mapSonyState(state: SonyCameraState['state']): CameraCoreSessionState;
export declare function mapSonyCandidate(device: SonyCameraInfo, hasCoordinateFocus: boolean): CameraCoreCandidate;
export declare function normalizeSonyError(error: unknown, operation: CameraCoreCommand['type'] | 'connect'): CameraCoreError;
export declare class SonyCameraCorePlugin implements CameraCorePlugin {
    private readonly native;
    private activeSession;
    constructor(native?: SonyCameraNativePort | null);
    descriptor(): CameraCorePluginDescriptor;
    isAvailable(): Promise<boolean>;
    discover(): Promise<CameraCoreCandidate[]>;
    connect(request?: CameraCoreConnectRequest): Promise<CameraCorePluginSession>;
}
export declare function createSonyCameraCorePlugin(native?: SonyCameraNativePort | null): SonyCameraCorePlugin;
export {};
//# sourceMappingURL=SonyCameraCoreAdapter.d.ts.map