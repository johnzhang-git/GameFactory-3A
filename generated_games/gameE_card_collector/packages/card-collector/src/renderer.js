/**
 * The 2D-leaning presentation: a single 3D display stand.
 *
 * The game reads as a flat card-collection UI, so this scene is small and
 * staged rather than explorable: a chest on a table that hops when opened,
 * and a wall of collected cards behind it. Everything is built from
 * framework primitives (`createRoundedBox`, `createMaterial`) and one
 * `CanvasTexture` card face, so it renders with no imported `.glb`.
 *
 * The camera is a fixed orbit around the stand; the host owns the frame
 * loop, and this module only steps its own animations from `onTick`.
 */

import * as THREE from 'three';
import {
  A3GameMaterialPreset,
  createContactShadow,
  createFillLight,
  createMaterial,
  createRoundedBox,
  createSunLight,
} from '@a3game/playable';
import { RARITY_PROFILE, cardIdFromName } from './catalog.js';

/** How long a chest-open hop lasts, in seconds. */
const CHEST_HOP_SECONDS = 0.5;
/** Card-wall geometry, in metres. */
const CARD_WIDTH = 0.62;
const CARD_HEIGHT = 0.86;
const CARD_DEPTH = 0.06;
const WALL_COLUMNS = 6;
const WALL_ROWS = 3;

/**
 * Paint one card face into a canvas, so a card's rarity colour and name
 * are visible without any external texture.
 */
function buildCardTexture(name, rarity) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 360;
  const ctx = canvas.getContext('2d');

  const profile = RARITY_PROFILE[rarity];
  const color = '#' + profile.color.toString(16).padStart(6, '0');

  // Card body.
  ctx.fillStyle = '#f6f4ee';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Rarity band across the top.
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, 64);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(0, 64, canvas.width, 6);

  // Rarity label.
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 30px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(profile.label.toUpperCase(), canvas.width / 2, 34);

  // A simple emblem circle below the band.
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(canvas.width / 2, 150, 44, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.font = 'bold 34px system-ui, sans-serif';
  ctx.fillText(name.slice(0, 1), canvas.width / 2, 150);

  // Card name.
  ctx.fillStyle = '#26282e';
  ctx.font = 'bold 26px system-ui, sans-serif';
  ctx.fillText(name, canvas.width / 2, 258);

  // Level pips placeholder (filled per-card in the DOM HUD instead).
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * Card faces are deterministic per (name, rarity), so their textures are
 * cached. Rebuilding a canvas and re-uploading every frame would leak GPU
 * memory and burn the render loop on a wall that rarely changes.
 */
const cardTextureCache = new Map();

function getCardTexture(name, rarity) {
  const key = `${rarity}:${name}`;
  let texture = cardTextureCache.get(key);
  if (!texture) {
    texture = buildCardTexture(name, rarity);
    cardTextureCache.set(key, texture);
  }
  return texture;
}

function buildChest() {
  const group = new THREE.Group();
  group.name = 'chest';

  const base = createRoundedBox({
    width: 0.9,
    height: 0.55,
    depth: 0.62,
    radius: 0.05,
    preset: A3GameMaterialPreset.WOOD,
    color: 0x6b4a2b,
  });
  base.position.y = 0.275;
  group.add(base);

  const lid = createRoundedBox({
    width: 0.9,
    height: 0.28,
    depth: 0.62,
    radius: 0.06,
    preset: A3GameMaterialPreset.WOOD,
    color: 0x8a5f36,
  });
  lid.position.y = 0.69;
  group.add(lid);

  const band = createRoundedBox({
    width: 0.92,
    height: 0.12,
    depth: 0.64,
    radius: 0.03,
    preset: A3GameMaterialPreset.METAL,
    color: 0xd4a017,
  });
  band.position.y = 0.55;
  group.add(band);

  group.userData.lid = lid;
  group.userData.baseY = group.position.y;
  return group;
}

/** A static group that re-renders the wall from the current collection. */
class CardWall {
  constructor(group) {
    this.group = group;
    this.slots = [];
    for (let row = 0; row < WALL_ROWS; row += 1) {
      for (let column = 0; column < WALL_COLUMNS; column += 1) {
        const slot = new THREE.Group();
        slot.position.set(
          (column - (WALL_COLUMNS - 1) / 2) * (CARD_WIDTH + 0.14),
          (WALL_ROWS - 1 - row) * (CARD_HEIGHT + 0.16),
          0,
        );
        this.group.add(slot);
        this.slots.push(slot);
      }
    }
  }

  /** Draw `cards` (from `economy.collectionList()`) across the wall. */
  render(cards) {
    let index = 0;
    for (const card of cards) {
      if (index >= this.slots.length) break;
      this.#fill(this.slots[index], card);
      index += 1;
    }
    for (; index < this.slots.length; index += 1) {
      this.#empty(this.slots[index]);
    }
  }

  #fill(slot, card) {
    let mesh = slot.userData.mesh;
    const texture = getCardTexture(card.name, card.rarity);
    if (mesh) {
      mesh.material.map = texture;
      mesh.material.needsUpdate = true;
    } else {
      mesh = new THREE.Mesh(
        new THREE.BoxGeometry(CARD_WIDTH, CARD_HEIGHT, CARD_DEPTH),
        new THREE.MeshStandardMaterial({ map: texture, roughness: 0.55 }),
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `card-${cardIdFromName(card.name)}`;
      slot.add(mesh);
      slot.userData.mesh = mesh;
    }
    slot.visible = true;
  }

  #empty(slot) {
    slot.visible = false;
  }
}

export class CardCollectorRenderer {
  /**
   * @param {{host: object, root: THREE.Object3D}} deps
   */
  constructor({ host, root }) {
    this.host = host;
    this.root = root;
    this._hopT = 0;
  }

  /** Build the scene and return the chest group the game animates. */
  build() {
    this.stage = new THREE.Group();
    this.stage.name = 'card-collector-stage';

    // A table the chest sits on.
    const tableTop = createRoundedBox({
      width: 2.4,
      height: 0.12,
      depth: 1.4,
      radius: 0.04,
      preset: A3GameMaterialPreset.WOOD,
      color: 0x4a3620,
    });
    tableTop.position.y = 0.84;
    this.stage.add(tableTop);

    for (const dx of [-1, 1]) {
      const leg = createRoundedBox({
        width: 0.16,
        height: 0.84,
        depth: 0.16,
        radius: 0.03,
        preset: A3GameMaterialPreset.WOOD,
        color: 0x3a2a18,
      });
      leg.position.set(dx * 0.95, 0.42, 0);
      this.stage.add(leg);
    }

    this.chest = buildChest();
    this.chest.position.set(0, 0.9, 0);
    this.stage.add(this.chest);

    // The wall of collected cards behind the table.
    this.wall = new CardWall(new THREE.Group());
    this.wall.group.position.set(0, 2.3, -1.6);
    this.stage.add(this.wall.group);

    this.root.add(this.stage);

    // Grounding shadows are one draw call each and keep the stand readable.
    const shadow = createContactShadow({ radius: 1.3, opacity: 0.35 });
    shadow.position.y = 0.01;
    this.root.add(shadow);

    return this.chest;
  }

  /** Start the chest-open hop animation. */
  hopChest() {
    this._hopT = CHEST_HOP_SECONDS;
  }

  /** Re-render the collected-card wall from `cards`. */
  renderWall(cards) {
    this.wall.render(cards);
  }

  /** Step the hop; called from the host tick. */
  update(delta) {
    if (this._hopT <= 0) return;
    this._hopT -= delta;
    const t = Math.max(0, this._hopT) / CHEST_HOP_SECONDS;
    // Hop up then land: a half-sine peak at the midpoint.
    const lift = Math.sin((1 - t) * Math.PI) * 0.5;
    this.chest.position.y = 0.9 + lift;
    if (this._hopT <= 0) this.chest.position.y = 0.9;
  }

  dispose() {
    this.stage.traverse((object) => {
      if (object.geometry) object.geometry.dispose();
      if (object.material) {
        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material];
        for (const material of materials) {
          material.dispose();
        }
      }
    });
    // Card faces are shared across meshes via the cache; dispose them once.
    for (const texture of cardTextureCache.values()) {
      texture.dispose();
    }
    cardTextureCache.clear();
  }
}

/**
 * Light the stand. Environment map + one sun + fill is enough to make the
 * PBR materials read; without the environment map they render flat.
 */
export function lightStage(host) {
  host.setEnvironment({ preset: 'room', environmentIntensity: 0.9 });
  const sun = createSunLight({
    position: { x: 6, y: 9, z: 4 },
    radius: 8,
    intensity: 2.2,
    color: 0xfff2d8,
  });
  host.add(sun, 'lights');
  const fill = createFillLight({
    skyColor: 0xbcd0e0,
    groundColor: 0x2a2622,
    intensity: 0.6,
  });
  host.add(fill, 'lights');
  return { sun, fill };
}

/** Position the host camera on a fixed orbit around the stand. */
export function aimCamera(host) {
  host.camera.position.set(3.4, 3.2, 5.2);
  host.camera.lookAt(new THREE.Vector3(0, 1.5, 0));
}
