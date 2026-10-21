# a™ for iPhone and iPad

A native shell (Capacitor 7) around https://local-assets.com: every deploy of the website reaches the app at once.
Inside the app the website loads `la-native.js`, which adds what a web page can't do:

- **Sign in with Google through Safari** (Google blocks sign-in inside apps), handed back to the app via `localassets://signed-in`, the same one-time-secret flow as the Mac app (`api/google-auth`).
- **Push notifications**: the device token goes to `api/push-token` (stored per account in Redis `push_tokens:<venue>`). Sending needs an APNs key (below).
- The iOS share sheet, Photos, camera and microphone for clips and recordings; an offline screen (`www/offline.html`).

## Build and submit (needs a Mac with Xcode and the Apple Developer account)

1. Install Xcode from the App Store, open it once, then in Terminal: `sudo xcode-select -s /Applications/Xcode.app`.
2. In this folder: `npm install`, then `node node_modules/@capacitor/cli/bin/capacitor sync ios`
   (`npx cap` doesn't work here: the folder name `LOCAL : ASSETS` has a colon).
3. `node node_modules/@capacitor/cli/bin/capacitor open ios` opens the project in Xcode.
4. In Xcode → target **App** → Signing & Capabilities: choose your Team. Add the **Push Notifications** capability (the entitlements file is already there).
5. Product → Archive, then Distribute App → App Store Connect → Upload.
6. In App Store Connect: create the app (bundle ID `com.localassets.app`), add screenshots, the privacy policy URL (https://local-assets.com/privacy), and a **demo account** for the reviewer (Apple needs one to sign in).

## Push notifications (optional, later)

Create an APNs key at developer.apple.com → Keys (Apple Push Notifications service), and add it to Vercel as
environment variables (never in a file): `APNS_KEY` (the .p8 contents), `APNS_KEY_ID`, `APNS_TEAM_ID`.
Then local / assets can send "clips ready" notifications to the tokens in `push_tokens:<venue>`.
