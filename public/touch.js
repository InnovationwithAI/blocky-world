// Touch (iPad) controls, layered on top of the keyboard/mouse game in client.js.
//
// Everything here works by feeding the same inputs the keyboard does - joystick
// sets the move flags, drag-to-look turns the camera the way the arrow keys do,
// and buttons dispatch synthetic key events - so every game rule, menu and
// toggle behaves identically and nothing in client.js had to be duplicated.
// Classic scripts share one global scope, so this file can use client.js's
// top-level names (move, camera, gameStarted, IS_TOUCH...) directly.
if (IS_TOUCH) {
  (function () {
    const MAX_PITCH = Math.PI / 2 - 0.05;
    const LOOK_SPEED_X = 0.0055;
    const LOOK_SPEED_Y = 0.0045;

    // ----- keyboard bridge -----
    function pressKey(code) { document.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true })); }
    function releaseKey(code) { document.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true })); }
    function markTouch() { lastTouchTime = performance.now(); }
    // Keeps receiving a finger's moves even after it slides off the element.
    // Can throw for a pointer that no longer exists, which must not break the press.
    function capture(el, id) { try { el.setPointerCapture(id); } catch (e) { /* ignore */ } }

    // Pinch/double-tap zoom must never fight the game (Safari-specific events).
    ['gesturestart', 'gesturechange', 'gestureend'].forEach((t) =>
      document.addEventListener(t, (e) => e.preventDefault()));

    // Start screen wording.
    const startText = document.querySelector('#instructions p');
    if (startText) {
      startText.innerHTML = 'Tap anywhere to play. Left thumb moves, drag the right side of the screen to look around.<br>' +
        'Use the buttons on the right to jump, mine and place blocks.';
    }

    const craftHint = document.getElementById('craft-hint');
    if (craftHint) craftHint.textContent = 'Tap a recipe, then tap Craft \u00b7 \u2715 to close';

    // ----- build the controls -----
    const ui = document.createElement('div');
    ui.id = 'touch-ui';
    ui.innerHTML = `
      <div id="joy-zone"><div id="joy-base"></div><div id="joy-knob"></div></div>
      <div id="touch-actions">
        <div class="tbtn" id="tb-jump" data-hold="Space">&#9650;<small></small></div>
        <div class="tbtn" id="tb-mine" data-hold="KeyJ">&#9935;</div>
        <div class="tbtn" id="tb-place" data-tap="KeyK">&#9635;</div>
      </div>
      <div id="touch-util">
        <div class="tbtn" data-tap="KeyE">Craft</div>
        <div class="tbtn" data-tap="KeyX">Bag</div>
        <div class="tbtn" data-tap="KeyC">Use</div>
        <div class="tbtn" data-tap="KeyF">Eat</div>
        <div class="tbtn" id="tb-more">More</div>
      </div>
      <div id="touch-more">
        <div class="tbtn" data-tap="Digit7">Seeds</div>
        <div class="tbtn" data-tap="Digit8">Water</div>
        <div class="tbtn" data-tap="Digit9">Lava</div>
        <div class="tbtn" data-tap="Digit0">Torch</div>
        <div class="tbtn" data-tap="KeyB">Breed</div>
        <div class="tbtn" data-tap="KeyN">Sleep</div>
        <div class="tbtn" data-tap="KeyR">Ride</div>
        <div class="tbtn" data-tap="KeyT">Trade</div>
        <div class="tbtn" data-tap="KeyY">Shear</div>
        <div class="tbtn" data-tap="KeyH">Fish</div>
        <div class="tbtn" data-tap="KeyV">Potion</div>
        <div class="tbtn" data-tap="KeyU">Eye</div>
        <div class="tbtn" data-hold="ShiftLeft">Fly down</div>
        <div class="tbtn" data-tap="KeyG">Creative</div>
        <div class="tbtn" data-tap="Enter">Chat</div>
        <div class="tbtn" data-tap="KeyM">New game</div>
      </div>`;
    document.body.appendChild(ui);

    // ----- buttons: data-tap fires once on press, data-hold stays down until release -----
    ui.querySelectorAll('[data-tap], [data-hold]').forEach((btn) => {
      const holdCode = btn.dataset.hold;
      const tapCode = btn.dataset.tap;
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        markTouch();
        capture(btn, e.pointerId);
        btn.classList.add('down');
        if (holdCode) pressKey(holdCode); else pressKey(tapCode);
        // A tap on an action closes the "More" panel so it never lingers over the game.
        if (tapCode) moreEl.classList.remove('open');
      });
      const release = (e) => {
        markTouch();
        btn.classList.remove('down');
        if (holdCode) releaseKey(holdCode);
        else if (tapCode) releaseKey(tapCode);
      };
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
    });

    const moreEl = document.getElementById('touch-more');
    document.getElementById('tb-more').addEventListener('pointerdown', (e) => {
      e.preventDefault();
      markTouch();
      moreEl.classList.toggle('open');
    });

    // ----- movement joystick (floating: appears where the left thumb lands) -----
    const joyZone = document.getElementById('joy-zone');
    const joyBase = document.getElementById('joy-base');
    const joyKnob = document.getElementById('joy-knob');
    const JOY_RADIUS = 52;
    const DEADZONE = 0.3;
    const defaultBase = { left: joyBase.style.left, bottom: joyBase.style.bottom };
    let joyId = null, joyCx = 0, joyCy = 0;

    function setMove(dx, dy) {
      move.forward = dy < -DEADZONE;
      move.back = dy > DEADZONE;
      move.left = dx < -DEADZONE;
      move.right = dx > DEADZONE;
    }
    function centerJoystickAt(x, y) {
      const w = joyBase.offsetWidth, k = joyKnob.offsetWidth;
      joyBase.style.left = (x - w / 2) + 'px';
      joyBase.style.bottom = (window.innerHeight - y - w / 2) + 'px';
      joyKnob.style.left = (x - k / 2) + 'px';
      joyKnob.style.bottom = (window.innerHeight - y - k / 2) + 'px';
    }
    function resetJoystick() {
      joyId = null;
      setMove(0, 0);
      joyBase.style.left = defaultBase.left; joyBase.style.bottom = defaultBase.bottom;
      joyKnob.style.left = ''; joyKnob.style.bottom = '';
    }
    joyZone.addEventListener('pointerdown', (e) => {
      if (joyId !== null) return;
      e.preventDefault();
      markTouch();
      joyId = e.pointerId;
      capture(joyZone, e.pointerId);
      joyCx = e.clientX; joyCy = e.clientY;
      centerJoystickAt(joyCx, joyCy);
    });
    joyZone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== joyId) return;
      let dx = e.clientX - joyCx, dy = e.clientY - joyCy;
      const len = Math.hypot(dx, dy);
      if (len > JOY_RADIUS) { dx = dx / len * JOY_RADIUS; dy = dy / len * JOY_RADIUS; }
      const k = joyKnob.offsetWidth;
      joyKnob.style.left = (joyCx + dx - k / 2) + 'px';
      joyKnob.style.bottom = (window.innerHeight - (joyCy + dy) - k / 2) + 'px';
      setMove(dx / JOY_RADIUS, dy / JOY_RADIUS);
    });
    const joyEnd = (e) => { if (e.pointerId === joyId) { markTouch(); resetJoystick(); } };
    joyZone.addEventListener('pointerup', joyEnd);
    joyZone.addEventListener('pointercancel', joyEnd);

    // ----- drag anywhere else on the game view to look around -----
    const canvas = renderer.domElement;
    let lookId = null, lastX = 0, lastY = 0;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || lookId !== null) return;
      if (!gameStarted || craftMenuOpen || invScreenOpen) return;
      e.preventDefault();
      markTouch();
      lookId = e.pointerId;
      lastX = e.clientX; lastY = e.clientY;
      capture(canvas, e.pointerId);
      moreEl.classList.remove('open');
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId !== lookId) return;
      camera.rotation.y -= (e.clientX - lastX) * LOOK_SPEED_X;
      camera.rotation.x = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, camera.rotation.x - (e.clientY - lastY) * LOOK_SPEED_Y));
      lastX = e.clientX; lastY = e.clientY;
    });
    const lookEnd = (e) => { if (e.pointerId === lookId) { markTouch(); lookId = null; } };
    canvas.addEventListener('pointerup', lookEnd);
    canvas.addEventListener('pointercancel', lookEnd);

    // ----- tap a hotbar slot to select it -----
    document.getElementById('hotbar').addEventListener('pointerdown', (e) => {
      const slot = e.target.closest('.slot');
      if (!slot) return;
      e.preventDefault();
      markTouch();
      const idx = Array.prototype.indexOf.call(slot.parentNode.children, slot);
      if (idx >= 0 && idx < 6) pressKey('Digit' + (idx + 1));
    });

    // Hide the controls behind full-screen menus and until the game starts.
    function syncVisibility() {
      ui.style.display = gameStarted ? '' : 'none';
    }
    setInterval(syncVisibility, 200);
    syncVisibility();

    // A held button/stick must not stay stuck if the finger leaves the page.
    window.addEventListener('blur', () => { resetJoystick(); releaseKey('KeyJ'); releaseKey('Space'); releaseKey('ShiftLeft'); });
  })();
}

// Menu close buttons (there is no Escape/E/X key on a tablet) - harmless and
// handy with a mouse too, so they are wired up on every device.
document.getElementById('craft-close').addEventListener('click', () => { if (craftMenuOpen) toggleCraftMenu(); });
document.getElementById('inv-close').addEventListener('click', () => { if (invScreenOpen) toggleInventoryScreen(); });
