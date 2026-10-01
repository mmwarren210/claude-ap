# Mobile package audit — Expo SDK 57

Scope: `apps/mobile` only. Audit precedes the attempted install. The Expo installer could not reach the package registry through the workspace proxy, so unverified native libraries were not added. No paid service or key was configured. Confirm native performance/accessibility on iOS and Android before release.

| Candidate | Installed before? | Need / feature | Expo compatibility / maintenance | Native configuration / decision |
| --- | --- | --- | --- | --- |
| Expo Router | Yes | Five tabs, player detail, deep-link route | SDK 57 maintained by Expo | Retain; no direct React Navigation replacement. |
| `@gorhom/bottom-sheet` | No | Gesture-based ladders/filters | Maintained upstream; relies on Gesture Handler and Reanimated | Install later after SDK 57 native validation; built-in `Modal` sheet used now, without gesture snap points. |
| `react-native-reanimated`, `react-native-worklets` | Yes | Native motion runtime | SDK 57 bundled versions | No new animations justified; no added motion. |
| `react-native-gesture-handler` | No | Gesture sheet dependency | Listed in Expo SDK 57 third-party docs | Deferred with Gorhom; requires root gesture integration and native testing. |
| `@react-native-async-storage/async-storage` | No | Preferences/draft persistence | Listed in Expo SDK 57 docs; unencrypted storage | Deferred due registry proxy; installed Expo FileSystem module used for non-secret JSON instead. |
| `expo-file-system` | Transitive only | Cache and local draft | Expo-maintained, SDK 57 recommended `~57.0.7` | Added direct dependency offline; bundled in Expo Go. No secrets in stored files. |
| `@react-native-community/netinfo` | No | True radio connectivity state | Listed in Expo SDK 57 third-party docs | Deferred due registry proxy. Fetch failure is labeled unreachable/offline-like; not a definitive radio-status check. |
| `expo-haptics` / third-party haptics | No | Small success/error taps | Expo-native preferred | Deferred; no fake vibration implementation. |
| `react-native-share` / `expo-sharing` | No | Sharing text | Built-in RN `Share` sufficient for current Crown draft | Reject until branded image/file sharing exists. |
| `react-native-view-shot` | No | Branded images | Listed in Expo SDK 57 docs | Defer; graphic generator outside scope. |
| `@shopify/flash-list` | No | Very large boards | Listed in Expo SDK 57 docs | Defer; tuned `FlatList` first; profile real large board on device. |
| Firebase Crashlytics | No | Native crash reporting | Requires Firebase native project credentials/config and development builds | Defer; owner must select diagnostics vendor/configuration. Never silently activate paid services. |

Current UX: Board and Rankings reuse one validated board response; Board uses virtualized cards and a filter modal; player details and ladder use Expo Router and compact modal; Crown tray is a local draft across tabs. The native filesystem persists the board cache and non-sensitive draft. The app does **not** claim server approval of the draft, correlation checks, or freshness of old findings. It displays LIVE/CACHED/STALE based on provider timestamp, OFFLINE for verified browser network loss, and UNREACHABLE on fetch failures; NetInfo is needed to identify true native-device offline state.

Native follow-up: retry `npx expo install @gorhom/bottom-sheet react-native-gesture-handler @react-native-async-storage/async-storage @react-native-community/netinfo expo-haptics` when registry access is restored, implement gesture root/sheet and connectivity callbacks, test on actual iOS/Android builds, and decide on Crashlytics with owner-supplied Firebase configuration. No replacement of current route, data-provider, research or scoring architecture is necessary.
