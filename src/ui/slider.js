import Phaser from 'phaser';

// A compact horizontal slider widget for Phaser scenes (used by the Music tab's tuner). One
// row: [label] [track + fill + handle] [value]. Dragging the track/handle sets the value,
// snapped to `step`, and calls `onChange(value)`. Drag is coordinated through the scene via a
// single `scene._activeSlider` ref so we don't add a pair of input listeners per slider —
// call Slider.attachDrag(scene) once in the scene's create().

const C = {
  label: '#9aa6b2', value: '#efc14a', track: 0x2a333f, fill: 0x5ec8e0, handle: 0xc8d2dd,
};

const decimals = (step) => (step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3);
export const fmtStep = (v, step) => Number(v).toFixed(decimals(step));

export class Slider {
  // Wire one set of pointer listeners that drive whichever slider is being dragged.
  static attachDrag(scene) {
    if (scene._sliderDragAttached) return;
    scene._sliderDragAttached = true;
    scene._activeSlider = null;
    scene.input.on('pointermove', (p) => { if (scene._activeSlider) scene._activeSlider._applyPointer(p); });
    scene.input.on('pointerup', () => { scene._activeSlider = null; });
  }

  constructor(scene, { x, y, w, labelW = 104, valueW = 34, label, min, max, step, value, onChange }) {
    this.scene = scene;
    this.min = min; this.max = max; this.step = step; this.onChange = onChange;
    this.value = value;

    const trackX = x + labelW;
    const trackW = w - labelW - valueW - 8;
    this.trackX = trackX; this.trackW = trackW;
    const cy = y + 7;

    this.container = scene.add.container(0, 0);
    this.labelText = scene.add.text(x, y, label, { fontFamily: 'monospace', fontSize: '10px', color: C.label });
    this.trackRect = scene.add.rectangle(trackX, cy, trackW, 4, C.track).setOrigin(0, 0.5);
    this.fillRect = scene.add.rectangle(trackX, cy, 0, 4, C.fill).setOrigin(0, 0.5);
    this.handle = scene.add.rectangle(trackX, cy, 6, 13, C.handle).setOrigin(0.5);
    this.valueText = scene.add.text(x + w - valueW, y, '', { fontFamily: 'monospace', fontSize: '10px', color: C.value }).setOrigin(0, 0);

    // A generous hit zone over the whole track row so it's easy to grab.
    this.hit = scene.add.rectangle(trackX, cy, trackW, 16, 0xffffff, 0).setOrigin(0, 0.5)
      .setInteractive({ useHandCursor: true });
    this.hit.on('pointerdown', (p) => { scene._activeSlider = this; this._applyPointer(p); });

    this.container.add([this.labelText, this.trackRect, this.fillRect, this.handle, this.valueText, this.hit]);
    this._paint();
  }

  _applyPointer(p) {
    const frac = Phaser.Math.Clamp((p.worldX - this.trackX) / this.trackW, 0, 1);
    let v = this.min + frac * (this.max - this.min);
    v = Math.round(v / this.step) * this.step;
    v = Phaser.Math.Clamp(v, this.min, this.max);
    if (v === this.value) return;
    this.value = v;
    this._paint();
    this.onChange?.(v);
  }

  setValue(v) { this.value = v; this._paint(); }

  _paint() {
    const frac = (this.value - this.min) / (this.max - this.min || 1);
    this.fillRect.width = this.trackW * frac;
    this.handle.x = this.trackX + this.trackW * frac;
    this.valueText.setText(fmtStep(this.value, this.step));
  }

  destroy() { this.container.destroy(); }
}
