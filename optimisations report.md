Here is the comprehensive, high-performance architectural specification for Nono-Terminal's low-latency remote control layer. It details the verified technical decisions, APIs, protocols, and architectural corrections needed to achieve ultra-low latency, optimal GPU acceleration, and crisp image quality on the target platform.

---

# Architectural Specification: Low-Latency AI Terminal Remote Control

**Target Environment:** Dell XPS 15 9500 (4K screen, Intel iGPU + Nvidia dGPU Hybrid Graphics) running Arch Linux with Hyprland and ElectronJS.

---

## 1. Input Injection Layer (Zero-Fork Sockets)

### Objective

Eliminate input lag by bypassing shell invocation overhead (no `child_process.spawn()` or `exec()` for CLI wrappers like `hyprctl`). Implement direct communication over Hyprland’s native UNIX socket.

### Execution Details

- **Protocol:** Unix Domain Sockets.
- **Path Resolution:** Retrieve the socket path dynamically using `XDG_RUNTIME_DIR` and `HYPRLAND_INSTANCE_SIGNATURE`:
  `$XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE/.socket.sock`
- **Connection Model (Correction):** 
  > [!IMPORTANT]
  > Hyprland's command socket is strictly request-response: it executes the incoming command, returns the output, and immediately closes the socket. Persistent long-lived socket connections are not supported by the Hyprland server.
  - Establish short-lived socket connections (`net.createConnection`) on the backend for each input event. Because Unix domain sockets take <1ms to open and close, this remains extremely low-latency and avoids process-forking overhead.
- **Commands:** Write raw absolute pointer updates directly into the stream using the `movecursor` dispatcher:
  `dispatch movecursor <absolute_x> <absolute_y>\n`

---

## 2. Telemetry and Networking (UDP WebRTC Data Channels)

### Objective

Prevent cursor "stuttering" and "teleportation" caused by TCP Head-of-Line Blocking over Wi-Fi/cellular networks during packet loss.

### Execution Details

- **Signal Transport:** **Socket.io** is strictly restricted to initial SDP Offer/Answer negotiation and ICE Candidate exchange.
- **Data Transport:** Move 100% of the mouse/keyboard telemetry to a dedicated **WebRTC Data Channel**.
- **SCTP Configuration:** Force unreliable and unordered delivery on the data channel to emulate raw UDP:
  ```javascript
  const inputChannel = peerConnection.createDataChannel('mouseInput', {
  	ordered: false,
  	maxRetransmits: 0
  });
  ```
- **Routing Path (Correction):**
  - Because `RTCPeerConnection` runs in the desktop Electron Renderer process (`window.js`), mouse inputs received over the data channel must be forwarded to the Main process (`main.js`) via Electron IPC (`ipcRenderer.send`), which is a sub-millisecond local-memory transfer.
- **Client Throttling (Mobile App):** High-refresh rate mobile digitizers trigger excessive events. Implement a strict client-side **throttle** (e.g., 33ms or 50ms intervals) to limit transmissions to 20-30 Hz, drastically reducing system interrupts and main process events on the host.
- **Fallback Protocol:** Maintain a fallback mouse/keyboard input route over Socket.io in case the WebRTC connection fails or times out.

---

## 3. Screen Capture Layer (Wayland Ozone & PipeWire Bypass)

### Objective

Eradicate XWayland translation layers and fix the dual-dialog portal screen selection bug native to Chromium on Linux under Wayland.

### Execution Details

- **Platform Execution:** Force Electron to run natively on Wayland. Launch the binary with Ozone flags enabled by appending command line switches in the Electron Main Process:
  ```javascript
  app.commandLine.appendSwitch("enable-features", "UseOzonePlatform");
  app.commandLine.appendSwitch("ozone-platform", "wayland");
  ```
- **Zero-Copy Capture:** Leverage **PipeWire** to stream buffers directly from VRAM to Chromium/WebRTC without CPU interaction.
- **Double-Dialog Wayland Bug Bypass (Correction):** 
  - Chromium's default implementation of `desktopCapturer.getSources()` triggers a system portal picker, but using that source in `getUserMedia()` launches a second redundant prompt.
  - **Resolution:** Completely bypass `desktopCapturer.getSources()` in the Main process. The Renderer process does not need a real source ID under Wayland. Instead, return a mock source ID (e.g., `{ id: 'screen:0:0', width, height }`) from the `get-screen-source-id` IPC handler. 
  - When `getUserMedia()` is called with this mock ID, Chromium/PipeWire will intercept it and spawn the system portal picker exactly once.

---

## 4. Video Pipeline and Encoders (H.264 SDP Munging)

### Objective

Maximize performance using GPU hardware-accelerated encodings and eliminate latency-heavy buffering frames.

### Execution Details

- **Codec Forced Choice:** Force **H.264** to leverage GPU hardware encoders.
- **SDP Munging:** Parse and modify the local/remote Session Description Protocol (SDP). Prioritize the H.264 payload type with the `profile-level-id=42e01f` parameter.
  - `42e01f` represents the **Constrained Baseline Profile (Level 3.1)**. This profile strictly forbids **B-Frames** (predictive frames that wait on future frames, adding latency).
- **GPU Driver Selection (Correction for Hybrid Laptops):**
  > [!TIP]
  > On a hybrid Intel/Nvidia GPU setup, Hyprland runs on the Intel iGPU. Capturing the desktop screen via PipeWire keeps the framebuffer in Intel VRAM.
  - Rather than forcing Nvidia NVENC (which requires copying frames across PCIe from Intel VRAM to Nvidia VRAM, increasing latency and power usage), **prioritize Intel QuickSync / VA-API hardware encoding on the iGPU**. This uses `intel-media-driver` natively in Chromium, allowing a zero-copy encoding path.
- **WebRTC Framerate Constraint:**
  - Keep the screen stream capped at **30fps** (`maxFrameRate: 30`). This significantly reduces computational/GPU overhead (encoding and decoding complexity), drops power and battery usage on both host and mobile devices, and halves bandwidth requirements on wireless connections without compromising interactive terminal usability.
- **WebRTC Optimization Constraints:** Set active constraints on the `RTCRtpSender` to prioritize frame delivery under congested local network conditions:
  ```javascript
  const sender = peerConnection.getSenders().find(s => s.track.kind === 'video');
  if (sender) {
    const params = sender.getParameters();
    if (params && params.encodings && params.encodings.length > 0) {
      params.degradationPreference = 'maintain-framerate'; // Maintain frame rate, drop resolution if needed
      params.encodings[0].maxBitrate = 15000000; // Cap at 15Mbps for high-quality local network bandwidth
      await sender.setParameters(params);
    }
  }
  ```

---

## 5. Host-Side Viewport Cropping (WebCodecs Dynamic Zoom)

### Objective

Maintain high text legibility (1:1 pixel rendering) without sending a bandwidth-heavy, resource-intensive 4K stream to the mobile screen, while bypassing heavy CPU/main-thread Canvas drawing operations.

### Execution Details

- **Canvas-Based Cropping Critique:** Capturing 4K and using Canvas `ctx.drawImage` in a `requestAnimationFrame` loop blocks Electron's main JS thread and triggers slow VRAM-CPU-VRAM memory transfers.
- **Implementation (Correction):** Use the high-performance **WebCodecs & Insertable Streams (Breakout Box) API** to crop the video stream natively in GPU memory with zero-copy.
- **WebCodecs Crop Logic:**
  1. Process the capture stream track using `MediaStreamTrackProcessor`.
  2. Extract `VideoFrame` objects.
  3. Create a cropped `VideoFrame` natively using the `VideoFrame` constructor, passing a `visibleRect` calculated from the current crop coordinates:
     ```javascript
     const croppedFrame = new VideoFrame(originalFrame, {
       visibleRect: {
         x: Math.round(crop.x * originalFrame.codedWidth),
         y: Math.round(crop.y * originalFrame.codedHeight),
         width: Math.round(crop.w * originalFrame.codedWidth),
         height: Math.round(crop.h * originalFrame.codedHeight)
       }
     });
     ```
  4. Write the cropped frame to a `MediaStreamTrackGenerator` that feeds the WebRTC peer connection.
- **Dynamic Auto-Follow (Correction):** Implement a toggleable "Auto-Follow Cursor" mode. By tracking the cursor coordinates synced from the host (via `cursor-sync`), the desktop client can dynamically shift the crop region `visibleRect` to center around the active cursor, keeping the work focus in view automatically.
