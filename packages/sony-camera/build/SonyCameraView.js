import { requireNativeView } from 'expo';
import * as React from 'react';
const NativeView = requireNativeView('SonyCamera');
export default function SonyCameraView(props) {
    return <NativeView {...props}/>;
}
//# sourceMappingURL=SonyCameraView.js.map