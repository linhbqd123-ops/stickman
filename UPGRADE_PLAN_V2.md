# 🎮 Game Upgrade Plan V2: Ultimate System Overhaul

## 📋 Overview

**Tiêu chí upgrade V2:**
1. **Xóa hiệu ứng lóe sáng/Flash** - loại bỏ tất cả flash/screen flash gây khó chịu
2. **Upgrade Ultimate Skill** - Support 5 loại chiêu khác nhau với cơ chế riêng biệt
3. **Skill Drop System** - Thêm hệ thống vứt/nhặt skill
4. **Config System** - Tất cả thông số đều config được

---

## ULTIMATE SKILL SYSTEM - CHI TIẾT 5 CHIÊU

### 2.0 Ultimate Skill Config Structure

**File**: `js/config.js` - Thêm section:

```javascript
const ULTIMATE_SKILLS = {
    default: {
        id: 'default',
        name: 'Default Attack',
        icon: 'icon_default',  // Tự động từ UI
        description: 'Basic ultimate attack',
        damage: 80,
        forceStrength: 50,
        hitboxWidth: 120,
        hitboxHeight: 100,
        hitboxOffsetX: 50,
        hitboxOffsetY: 0,
        duration: 500,          // ms
        startDelay: 0,
        endDelay: 300,
        energyCost: 30,
        knockbackDistance: 150,
        knockbackDuration: 300, // ms
        enabled: true,
    },
    
    yasuo: {
        id: 'yasuo',
        name: 'Yasuo Wind Slash',
        icon: 'icon_yasuo',
        description: 'Slash out wind projectile',
        damage: 120,
        forceStrength: 80,
        hitboxWidth: 200,       // Luồng gió rộng hơn
        hitboxHeight: 150,
        hitboxOffsetX: 80,
        hitboxOffsetY: 0,
        duration: 600,
        startDelay: 100,
        endDelay: 400,
        energyCost: 35,
        knockbackDistance: 200,
        knockbackDuration: 400,
        projectileSpeed: 8,     // pixels/frame
        projectileRange: 'full', // Đi từ nhân vật đến cuối map
        teleportToHit: true,    // Teleport đến địch sau khi hit
        comboHits: 5,           // 5 hit liên hoàn
        comboDuration: 800,     // ms cho combo
        enabled: true,
    },
    
    kamehameha: {
        id: 'kamehameha',
        name: 'Kamehameha',
        icon: 'icon_saiyan',
        description: 'Powerful energy wave',
        damage: 100,
        forceStrength: 90,
        hitboxWidth: 180,
        hitboxHeight: 120,
        hitboxOffsetX: 70,
        hitboxOffsetY: -30,
        duration: 700,
        startDelay: 150,
        endDelay: 450,
        energyCost: 40,
        knockbackDistance: 220,
        knockbackDuration: 500,
        projectileSpeed: 7,
        projectileRange: 'full',
        projectileWidth: 180,
        projectileHeight: 120,
        enabled: true,
    },
    
    fpt: {
        id: 'fpt',
        name: 'Meteors Rain',
        icon: 'icon_fpt',
        description: 'Rain down meteors',
        damage: 20,             // Per meteor
        forceStrength: 35,      // Per meteor
        meteorCount: 8,
        meteorSpawnDuration: 3000,  // Spread 8 meteors trong 3s
        meteorHitboxRadius: 60,     // Config radius
        meteorDamageMultiplier: 1,  // Tương đương default/5
        energyCost: 45,
        knockbackDistance: 130,     // Per meteor
        knockbackDuration: 250,
        enabled: true,
    },
    
    saitama: {
        id: 'saitama',
        name: 'Saitama Serious Punch',
        icon: 'icon_saitama',
        description: 'Ultimate powerful punch',
        damage: 1000,           // 1000% damage
        forceStrength: 999,     // Cực mạnh
        videoPath: 'assets/videos/saitama_punch.mp4',  // Video 3-5s
        videoWidth: 1280,
        videoHeight: 720,
        duration: 3000,         // Video duration (approx)
        startDelay: 0,
        endDelay: 500,
        energyCost: 50,         // Tiêu tốn 50, phục hồi được 25 (cost/2)
        energyCostPenalty: 0.5, // Giảm năng lượng/2 (mất thêm thời gian tích lại)
        cooldown: 30000,        // 30s cooldown
        knockbackDistance: 600, // Cực mạnh
        knockbackDuration: 800,
        freezeScreenDuration: 500,  // Freeze 500ms trước video
        affectAllEnemies: true,     // Hit tất cả địch dù ở đâu
        maxInstanceCount: 1,        // Chỉ 1 ulti saitama tồn tại
        rarity: 0.02,              // 2% chance drop
        enabled: true,
        dropOnMap: true,       // Rơi tự do trên map, có thể nhặt được
        bounceOnMap: true,     // Nảy quanh map
        bounceVelocityX: {min: -4, max: 4},
        bounceVelocityY: {min: -3, max: -1},
        bounceGravity: 0.3,
    },
};

// Thêm vào CONFIG freeze
const CONFIG = Object.freeze({
    // ... existing ...
    ULTIMATE_SKILLS,
    DEFAULT_ULTIMATE: 'default',
    // ... rest ...
});
```

---

### 2.1 CHIÊU DEFAULT

**Cơ chế:**
- Check lại hit box vì đang ko trúng đối thủ dù đứng gần
- Sử dụng config: `damage`, `forceStrength`, `hitboxWidth/Height`

**Implementation**: (Sẽ refactor từ`js/fighter.js` hiện tại)

**Checklist:
```
☐ Tính toán hitbox lại:
  - Hitbox nên bắt đầu từ phía trước nhân vật (offset dương)
  - Hitbox nên cover diện tích xung quanh (không quá nhỏ)
  ☐ Testing: Align visualizer với actual hit detection
  ☐ Verify hitbox relative vs absolute position
  ☐ Ensure offsetX/offsetY hoạt động đúng
☐ Spawn visual indicator (vẽ hình chữ nhật hoặc sprite để debug)
```

---

### 2.2 CHIÊU YASUO - WIND SLASH

**Icon Upload Guide:**
```
📁 Destination Folder: assets/maps/YOUR_SELECTED_MAP/
   (ví dụ: assets/maps/naruto/)

📷 File Requirements:
- Filename: yasuo_ultimate.png (hoặc .jpg)
- Size: 256×256px (hoặc 128×128px)
- Format: PNG with transparency recommended
- Style: Anime-style icon, Yasuo character or wind theme

📁 assets/
├── maps/
│   ├── naruto/
│   │   └── yasuo_ultimate.png  ✅ TẠI ĐÂY
│   ├── dragonball/
│   │   └── yasuo_ultimate.png  (copy thêm nếu dùng map khác)
│   └── fptsoftware/
│       └── yasuo_ultimate.png
└── ...

💾 Code to add in js/config.js:
// Load icon in preload
scene.load.image('icon_yasuo', 'assets/maps/naruto/yasuo_ultimate.png');

// Hoặc auto-detect map:
const mapKey = this.mapKey || 'naruto';
scene.load.image('icon_yasuo', `assets/maps/${mapKey}/yasuo_ultimate.png`);
```

**Cơ chế:**
1. **Tạo projectile (luồng gió)**
   - Spawn từ nhân vật position
   - Di chuyển với speed config đến cuối map
   - Hitbox: `hitboxWidth × hitboxHeight` lớn hơn default
   - Render: spiraling wind animation (particle effect)

2. **Khi trúng địch** (1 lần)
   - Gây damage + force theo config
   - **Teleport nhân vật** đến vị trí kẻ địch
   - **Combo 5 hit liên hoàn** từ nhiều hướng:
     ```
     Hit 1: Trước (forward slash)
     Hit 2: Trên (upward slash)
     Hit 3: Trái (left slash)
     Hit 4: Phải (right slash)
     Hit 5: Chính giữa (spin attack)
     ```
   - Mỗi hit gây (damage / 5) nên tổng = damage config
   - Combo diễn ra trong `comboDuration` (800ms)

3. **Visual & Sound:**
   - Wind effect particles
   - Sword slash sprite animations
   - Hit impact effect khi trúng

**Chi tiết code** - sẽ viết trong `js/fighter.js` + `js/particles.js`

---

### 2.3 CHIÊU KAMEHAMEHA - ENERGY WAVE

**Icon Upload Guide:**
```
📁 Destination: assets/maps/YOUR_MAP/
📷 File: saiyan_ultimate.png (hoặc kamehameha_ultimate.png)
- Size: 256×256px
- Super Saiyan icon hoặc Kamehameha wave
- Transparent background
```

**Cơ chế:**
1. **Tạo projectile (chưởng kame)**
   - Spawn từ tay/trước nhân vật
   - Size: `projectileWidth × projectileHeight`
   - Màu: Xanh lam/yellow glow
   - Hình dạng: circular/spherical energy ball
   - Di chuyển: `projectileSpeed` từ nhân vật đến cuối map
   
2. **Khi trúng:**
   - Gây damage + force toàn bộ địch
   - Phối hợp knockback với duration

3. **Visual:**
   - Energy glow animation
   - Particle trail
   - Explosion effect khi hit

---

### 2.4 CHIÊU FPT - METEORS RAIN

**Icon & Asset Upload Guide:**
```
📁 Destination: assets/maps/YOUR_MAP/ hoặc assets/effects/

📷 Files cần:
1. fpt_ultimate.png (icon, 256×256px, FPT logo hoặc tech theme)
2. meteor.png (8 copies hoặc 1 file, 80×80px)
   - Hình thiên thạch/asteroid
   - Hoặc 8 file khác nhau: meteor_1.png → meteor_8.png

Example structure:
📁 assets/
├── maps/
│   └── fptsoftware/
│       ├── fpt_ultimate.png      ← Icon
│       └── meteor.png (hoặc meteor_1.png...meteor_8.png)
└── effects/
    └── meteors/ (alternative)
        ├── meteor_1.png
        ...
        └── meteor_8.png
```

**Cơ chế:**
1. **Spawn 8 thiên thạch** trong 3000ms
   ```
   - Spaced: 3000ms / 8 = ~375ms between spawns
   - Random position: x: [100, canvasWidth-100], y: [0, 200]
   - Gravity: Fall naturally
   ```

2. **Hitbox cho mỗi thiên thạch:**
   - Circular: radius = `meteorHitboxRadius` (config)
   - Check collision với fighters

3. **Damage calculation:**
   - Config: `damage` = per meteor damage
   - Init: cứ để = default damage / 5
   - Knockback: `knockbackDistance` config per meteor

4. **Visual:**
   - Sprite thiên thạch rơi
   - Particle trail (smoke/fire)
   - Impact explosion khi hit or land

---

### 2.5 CHIÊU SAITAMA - SERIOUS PUNCH (Rarest)

**Icon & Video Upload Guide:**
```
📁 Assets Structure:

📷 Icon: saitama_ultimate.png
- Location: assets/maps/YOUR_MAP/ hoặc assets/effects/
- Size: 256×256px
- Style: Saitama serious face icon
- Rarity: 2% (phần lớn vận may)

🎬 Video: saitama_punch.mp4 (hoặc .webm)
- Location: assets/videos/
- Duration: 3-5 giây
- Resolution: 1280×720 (để fullscreen)
- Format: MP4 (H.264) hoặc WebM
- Content: Saitama serious punch scene (from anime)
- Size: < 20MB recommended

Example:
📁 assets/
├── maps/
│   └── [yourmap]/
│       └── saitama_ultimate.png
├── videos/
│   └── saitama_punch.mp4  (hoặc saitama_serious.mp4)
└── ...

💾 Code to load:
scene.load.image('icon_saitama', 'assets/maps/naruto/saitama_ultimate.png');
scene.load.video('saitama_video', 'assets/videos/saitama_punch.mp4');

⚠️ Video optimization tips:
- Use H.264 codec (better browser support)
- Compress: ffmpeg -i input.mp4 -c:v libx264 -crf 23 output.mp4
- Test fullscreen playback performance
```

**Cơ chế:**
1. **Spawnning & Rarity:**
   - Drop chance: 2% khi skill box rơi
   - **Chỉ tồn tại DUY NHẤT 1 chiêu saitama trên map** (`maxInstanceCount: 1`)
   - Nảy quanh map với gravity/bounce logic
   - Có thể nhặt như skill thường

2. **Khi sử dụng:**
   ```
   ① Freeze màn hình: 500ms (stopAllActions)
   ② Phát video: saitama_punch.mp4 (fullscreen, mute game sounds)
   ③ Video kết thúc → Trở lại game
   ④ Damage execute toàn bộ kẻ địch (dù ở đâu)
   ```

3. **Damage & Effect:**
   - **Damage:** 1000% (gây sát thương cực cao)
   - **Force:** 999 (knockback cực mạnh)
   - **Target:** ALL enemies (không phân biệt vị trí)
   - **Exclude:** Teammates (kiểm tra isTeammate)

4. **Balance:**
   - Energy cost: 50
   - Energy gained back: 25 (cost/2)
   - Phải mất 4 lần chiêu default để tích lại đủ
   - Cooldown: 30s (nếu muốn)

5. **Implementation Logic:**
   ```javascript
   // Check: only 1 saitama exists on map
   if (activeSaitamaCount >= 1) {
       return; // Không tạo thêm
   }
   
   // Execute:
   freezeScreen(500);
   playVideo('saitama_punch', {
       duration: 3500,
       fullscreen: true,
       mute: true
   });
   
   onVideoComplete({
       damageAllEnemies(damage: 1000%, force: 999);
       reducePlayerEnergy(50);
       // Energy không recovery, phải tích lại từ 25
   });
   ```

---

## 📦 PHẦN 3: HIT EFFECT SYSTEM

**Mọi chiêu áp dụng đều phải có hiệu ứng:**
- Visual: Flash sprite hoặc sprite bounce, không white flash
- Sound: Hit sound effect
- UI: Damage number popup ("+120 dmg")
- Animation: Knockback animation

**Config structure cho hit effect:**
```javascript
HIT_EFFECTS = {
    impact: {
        soundKey: 'sfx_impact',
        particleType: 'explosion',
        damageNumberColor: '#FFD700',
        durationMs: 300,
    },
    critical: {
        soundKey: 'sfx_critical',
        particleType: 'crit_explosion',
        damageNumberColor: '#FF0000',
        durationMs: 400,
    },
    // Thêm per-ultimate effect nếu cần
};
```

---

## 🎛️ PHẦN 4: SKILL DROP & PICK SYSTEM

### 4.0 Config:
```javascript
const SKILL_DROP_CONFIG = {
    dropChance: 0.15,           // 15% chance drop ulti skill
    dropHeight: 50,             // Spawn height above kill position
    skillBoxSize: 40,           // Sprite size
    pickupRadius: 60,           // Distance to auto-pickup
    dropGravity: 0.3,
    
    rarity: {
        default: 0.40,  // 40% chance
        yasuo: 0.20,    // 20%
        kamehameha: 0.15, // 15%
        fpt: 0.15,
        saitama: 0.02,  // 2% (hiếm)
        // Others: remaining %
    },
    
    // Keyboard bindings
    dropKey: {
        player1: 'F',        // Left player
        player2: '0',        // Right player (numpad 0)
    },
};
```

### 4.1 Drop Mechanic:
1. **Khi fighter die:** randomly drop ulti skill
2. **Skill box:**
   - Sprite: Glowing icon (của const ulti)
   - Size: 40×40px
   - Rotation animation
   - Particle glow effect
   
3. **Spawn position:**
   - x: dead position + random(-50, 50)
   - y: canvas height - 100 (near ground)

4. **Physics:**
   - Gravity: fall naturally
   - Bounce on ground
   - Despawn nếu: out of bounds hoặc > 60s

### 4.2 Pick-up Mechanic:
1. **Auto-pickup:**
   - Distance <= `pickupRadius` (60px)
   - Fighter walk over → auto grab
   - Show UI: "Picked up: [Skill Name]"

2. **Drop skill (NEW):**
   - **Player 1:** Press **F**
   - **Player 2:** Press **0** (numpad)
   - Effect: Current skill drop khỏi inventory
   - Skill spawn tại fighter position
   - **Ngay lập tức mất,** không thể re-pickup

3. **One skill at a time:**
   - Fighter chỉ có 1 ulti skill active
   - Nhặt skill mới → tự động drop cái cũ

### 4.3 Code Structure:
```
js/
├── skills/              (NEW folder)
│   ├── SkillManager.js  (Manage đang hold skill)
│   ├── SkillBox.js      (Skill item on map)
│   ├── SkillDrop.js     (Drop logic)
│   └── UltimateSystem.js (Execute ulti skills)
├── fighter.js           (Add skill property)
├── config.js            (SKILL_DROP_CONFIG + ULTIMATE_SKILLS)
└── scenes/GameScene.js  (Integrate skill system)
```

---

## 🔧 PHẦN 5: IMPLEMENTATION CHECKLIST

### Phase 1: Remove Flash Effects
- [ ] Search `flash(` in all files, comment/remove
- [ ] Search `shake(` remove camera shake
- [ ] Search particle flash emitters, remove
- [ ] Test: No white flashes during gameplay

### Phase 2: Config System
- [ ] Create `ULTIMATE_SKILLS` config object
- [ ] Freeze CONFIG with new structure
- [ ] Test: All skills config load correctly

### Phase 3: Default Skill (Hitbox Fix)
- [ ] Add hitbox visualizer (debug mode)
- [ ] Adjust `hitboxWidth, hitboxHeight, offsetX/Y`
- [ ] Test: Hitbox aligns with damage registration
- [ ] Verify hit detection vs invisible enemies

### Phase 4: Implement Each Skill (Sequence)
**Order: yasuo → kamehameha → fpt → saitama → default (refinement)**

#### Per-Skill Checklist:
- [ ] Define config values
- [ ] Create projectile/effect class
- [ ] Spawn & movement logic
- [ ] Hit detection & damage application
- [ ] Visual effects (particles, sprites, animations)
- [ ] Sound effects
- [ ] Damage number popup
- [ ] Knockback animation
- [ ] Testing: Does it feels right?

### Phase 5: Skill Drop System
- [ ] Create SkillBox class (sprite + physics)
- [ ] Implement drop on death logic
- [ ] Implement pick-up radius detection
- [ ] Implement drop key (F / 0)
- [ ] UI feedback
- [ ] Test: Drop, pickup, switch, drop again

### Phase 6: Hit Effects (Global)
- [ ] Create HitEffect system
- [ ] Apply to all skills consistently
- [ ] Test: Feedback clear & satisfying

### Phase 7: Integration & Polish
- [ ] GameScene fully integrated
- [ ] Game loop smooth
- [ ] Balance damage values
- [ ] Playtesting & bug fixing

---

## 📊 SKILL BALANCE DEFAULTS (Init Values)

| Skill | Damage | Force | Hitbox | Energy | Notes |
|-------|--------|-------|--------|--------|-------|
| **Default** | 80 | 50 | 120×100 | 30 | Base skill |
| **Yasuo** | 120 | 80 | 200×150 | 35 | Single hit + 5 combo |
| **Kamehameha** | 100 | 90 | 180×120 | 40 | Large projectile |
| **FPT** | 20×8 | 35×8 | 60radius×8 | 45 | 8 meteors |
| **Saitama** | 1000% | 999 | ∞ | 50 | 1 only, rare, global |

---

## 🎮 TESTING SCENARIOS

### Skill test checklist:
```javascript
// Test 1: Default skill
✓ Stand near enemy, use ulti → should hit
✓ Check hitbox position (debug visualizer)
✓ Damage number appears
✓ Enemy knocked back

// Test 2: Yasuo
✓ Projectile spawns & travels correctly
✓ Hit detection with projectile → teleport works
✓ 5 combo hits execute with proper spacing
✓ Each hit deals damage/5

// Test 3: Kamehameha
✓ Projectile size & speed correct
✓ Damage & knockback appropriate

// Test 4: FPT
✓ 8 meteors spawn over 3s
✓ Each meteor does config damage
✓ Multiple meteors hit same enemy stacks correctly

// Test 5: Saitama
✓ 2% drop rate works
✓ Only 1 on map at a time
✓ Video plays fullscreen
✓ All enemies take damage (even far away)
✓ Knockback applies to all

// Drop system test:
✓ Press F/0 → skill drops
✓ Dropped skill gone (not recoverable)
✓ Walk over skill → auto pickup
✓ Can't hold 2 skills
✓ Skills correctly rarity distributed
```

---

## 🚀 NEXT STEPS

1. **Read comments:** Tất cả config thông số có thể tune
2. **Start coding:** Bắt đầu từ Phase 1 (remove flash)
3. **Test often:** Mỗi phase test trước khi move next
4. **Balance:** Dùng config để tune weapon values
5. **Polish:** Add animations, particles, sounds

---

## 📝 NOTES & REFERENCES

- **Yasuo Wind Slash:** Reference từ League of Legends
- **Kamehameha:** Dragon Ball classic attack
- **Saitama Serious Punch:** One Punch Man finale
- **Video format:** Use H.264 MP4 for best compatibility
- **Rarity system:** saitama 2% = ~50 games trước khi ra

---

**Sẵn sàng code!** 🔥
