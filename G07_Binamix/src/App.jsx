import React, { useState, useEffect, useRef } from 'react';

// === 遊戲常數設定 ===
const WAVE_TYPES = {
    BELL: { id: 'bell', color: '100, 220, 255', norm: 2.0 }, 
    ROTOR: { id: 'rotor', color: '255, 204, 170', norm: 2.2 }, 
    FROG: { id: 'frog', color: '255, 85, 68', norm: 2.1 }, 
    WIND: { id: 'wind', color: '160, 255, 170', norm: 2.5 } 
};

const LEVEL_CONFIG = {
    1: { total: 600, name: '第一關：初試啼聲', sub: '盲聽 5.0s ➡️ 現身 5.0s' },
    2: { total: 540, name: '第二關：聽覺凝鍊', sub: '盲聽 4.5s ➡️ 現身 4.5s' },
    3: { total: 480, name: '第三關：盲狙大師', sub: '盲聽 4.0s ➡️ 現身 4.0s' }
};

const TARGETS_PER_LEVEL = 5;

export default function App() {
    const canvasRef = useRef(null);
    
    // === React UI 狀態 ===
    const [uiState, setUiState] = useState({
        status: 'locked', 
        score: 0, level: 1,
        comboText: '', comboColor: '#44ffaa',
        transTitle: '', transSub: '', transOpacity: 0,
        finalScore: 0, finalEval: '',
        irLoadedCount: 0 
    });

    // === 遊戲引擎核心狀態 ===
    const engine = useRef({
        audioCtx: null, masterCompressor: null, noiseBuffer: null, envConvolver: null,
        irs: {}, 
        pointerX: window.innerWidth / 2, pointerY: window.innerHeight / 2,
        bowAngle: 0, lastBowAngle: 0, rotationAccumulator: 0,
        score: 0, currentLevel: 1, targetsInLevel: 0, totalHits: 0,
        targetMole: null, arrows: [], particles: [], spawnTimer: 0, recoilTime: 0,
        width: 0, height: 0, dpr: 1, centerX: 0, listenerPlaneY: 0, uiScale: 1,
        status: 'locked',
        setUiState: null 
    });

    // === 核心遊戲迴圈與 Canvas 繪圖 ===
    useEffect(() => {
        engine.current.setUiState = setUiState;
        const ctx = canvasRef.current.getContext('2d');
        const game = engine.current;

        function initLayout() {
            game.dpr = window.devicePixelRatio || 1; 
            game.width = window.innerWidth; 
            game.height = window.innerHeight;
            canvasRef.current.width = game.width * game.dpr; 
            canvasRef.current.height = game.height * game.dpr; 
            ctx.setTransform(1, 0, 0, 1, 0, 0); 
            ctx.scale(game.dpr, game.dpr); 
            game.centerX = game.width / 2; 
            game.listenerPlaneY = game.height * 0.9; 
            game.uiScale = game.width / 1000 + 0.5;
        }

        function getMappedCoords(angleRad, distMeters) {
            const px = Math.sin(angleRad) * distMeters;
            const pz = -Math.cos(angleRad) * distMeters; 
            const zDepth = Math.abs(pz); 
            const fovScale = 400 * game.uiScale / (zDepth + 2.0); 
            const screenX = game.centerX + (px * fovScale);
            const screenY = game.listenerPlaneY - (zDepth * fovScale * 0.8);
            return { x: screenX, y: screenY, px: px, pz: pz, depthScale: Math.max(0.15, 3.0 / (zDepth + 3.0)) };
        }

        class TargetMole {
            constructor() {
                const typesArray = Object.values(WAVE_TYPES);
                this.type = typesArray[Math.floor(Math.random() * typesArray.length)];
                
                const zDepth = 4.0 + Math.random() * 8.0; 
                const margin = 80 * game.uiScale;
                const minScreenX = margin;
                const maxScreenX = game.width - margin;
                const targetScreenX = minScreenX + Math.random() * (maxScreenX - minScreenX);
                const fovScale = 400 * game.uiScale / (zDepth + 2.0); 
                const px = (targetScreenX - game.centerX) / fovScale;
                
                this.dist = Math.sqrt(px * px + zDepth * zDepth);
                this.angleRad = Math.atan2(px, zDepth); 
                this.updateProjection();
                this.pulse = 0;
                this.isDying = false;
                this.state = 0; 
                this.scale = 0; 
                
                const totalDuration = LEVEL_CONFIG[game.currentLevel].total || 600;
                this.revealTimer = Math.floor(totalDuration / 2); 
                this.aliveTimer = Math.floor(totalDuration / 2); 
                
                this.nodes = [];
                try { this.initAudio(); } catch(e) { console.warn("音訊初始化失敗", e); }
                
                game.setUiState(prev => ({ ...prev, comboText: "🔊 Binamix 盲聽索敵中...", comboColor: "#ffaa44" }));
            }

            updateProjection() {
                const coords = getMappedCoords(this.angleRad, this.dist);
                this.x = coords.x; this.y = coords.y;
                this.depthScale = coords.depthScale;
            }

            initAudio() {
                if (!game.audioCtx) return;
                const ctx = game.audioCtx;
                const now = ctx.currentTime;
                
                this.masterTargetGain = ctx.createGain(); 
                this.synthBus = ctx.createGain(); 
                this.synthBus.gain.value = 0.6;
                
                this.hasBinamix = game.irs && Object.keys(game.irs).length > 0;
                
                this.conchaBoost = ctx.createBiquadFilter(); this.conchaBoost.type = 'peaking'; this.conchaBoost.frequency.value = 3500;
                this.headShadow = ctx.createBiquadFilter(); this.headShadow.type = 'lowpass';
                let filterFreq = 15000 - (this.dist * 1200); 
                if (filterFreq < 600) filterFreq = 600;
                if (filterFreq > 24000) filterFreq = 24000;
                this.headShadow.frequency.value = filterFreq;
                
                this.synthBus.connect(this.conchaBoost);
                this.conchaBoost.connect(this.headShadow);

                if (this.hasBinamix) {
                    this.convA = ctx.createConvolver(); 
                    this.convA.normalize = false; 
                    this.convB = ctx.createConvolver(); 
                    this.convB.normalize = false; 
                    
                    this.gainA = ctx.createGain(); this.gainA.gain.value = 1; 
                    this.gainB = ctx.createGain(); this.gainB.gain.value = 0;
                    this.activeConv = 'A';
                    this.currentIrAngle = null;

                    this.binamixBoost = ctx.createGain();
                    this.binamixBoost.gain.value = 3.5;

                    this.headShadow.connect(this.convA);
                    this.headShadow.connect(this.convB);
                    this.convA.connect(this.gainA);
                    this.convB.connect(this.gainB);
                    
                    this.gainA.connect(this.binamixBoost);
                    this.gainB.connect(this.binamixBoost);
                    this.binamixBoost.connect(this.masterTargetGain);

                    // 💡 修正點 1：初始寫入時，完全不看 game.bowAngle
                    let targetDeg = (this.angleRad * 180 / Math.PI);
                    let sadieDeg = (360 - targetDeg) % 360; 
                    let nearestAngle = Math.round(sadieDeg / 15) * 15;
                    if (nearestAngle === 360) nearestAngle = 0;
                    
                    if (game.irs[nearestAngle]) {
                        this.convA.buffer = game.irs[nearestAngle];
                        this.currentIrAngle = nearestAngle;
                    }
                } else {
                    this.panner = ctx.createPanner();
                    this.panner.panningModel = 'HRTF';
                    this.headShadow.connect(this.panner);
                    this.panner.connect(this.masterTargetGain);
                }

                if (game.envConvolver) {
                    this.wetGain = ctx.createGain();
                    this.wetGain.gain.value = 0.0; 
                    this.headShadow.connect(this.wetGain);
                    this.wetGain.connect(game.envConvolver);
                }

                if (game.masterCompressor) this.masterTargetGain.connect(game.masterCompressor);

                if (this.type.id === 'bell') {
                    [440, 880, 1320].forEach((freq, i) => {
                        let osc = ctx.createOscillator(); let oscGain = ctx.createGain();
                        osc.type = 'sine'; osc.frequency.value = freq;
                        this.nodes.push({type: 'env', gain: oscGain, i: i, lastTrigger: 0});
                        osc.connect(oscGain); oscGain.connect(this.synthBus);
                        osc.start(now); this.nodes.push(osc);
                    });
                } else if (this.type.id === 'rotor') {
                    let osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 80;
                    let lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 10.0; 
                    let lfoGain = ctx.createGain(); lfoGain.gain.value = 0.8;
                    let amNode = ctx.createGain(); amNode.gain.value = 0;
                    lfo.connect(lfoGain);
                    try { const off = ctx.createConstantSource(); off.offset.value = 0.5; off.start(now); off.connect(lfoGain.gain); this.nodes.push(off); } catch(e) {}
                    lfoGain.connect(amNode.gain); osc.connect(amNode); amNode.connect(this.synthBus);
                    osc.start(now); lfo.start(now); this.nodes.push(osc, lfo);
                } else if (this.type.id === 'frog') {
                    let osc = ctx.createOscillator(); osc.type = 'square'; osc.frequency.value = 250;
                    let filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.Q.value = 8.0; filter.frequency.value = 600;
                    let lfo = ctx.createOscillator(); lfo.type = 'sawtooth'; lfo.frequency.value = 3.0; 
                    let lfoGain = ctx.createGain(); lfoGain.gain.value = 1500;
                    lfo.connect(lfoGain); lfoGain.connect(filter.frequency); osc.connect(filter); filter.connect(this.synthBus);
                    osc.start(now); lfo.start(now); this.nodes.push(osc, lfo);
                } else if (this.type.id === 'wind' && game.noiseBuffer) {
                    let src = ctx.createBufferSource(); src.buffer = game.noiseBuffer; src.loop = true;
                    let f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 2.0; f.frequency.value = 800;
                    src.connect(f); f.connect(this.synthBus);
                    src.start(now); this.nodes.push(src);
                }

                const distRatio = Math.max(0.01, 1.2 / (this.dist * 0.6 + 1.0));
                this.masterTargetGain.gain.setValueAtTime(0.0001, now);
                this.masterTargetGain.gain.setTargetAtTime(distRatio * this.type.norm, now, 0.2); 

                this.updateSpatialPosition(); 
            }

            updateSpatialPosition() {
                if (!game.audioCtx) return;
                
                // 💡 核心修正 2：動態追蹤也拔除 bowAngle
                // 聲音方位死死釘在目標產生的絕對位置 (this.angleRad)
                let targetDeg = (this.angleRad * 180 / Math.PI);

                if (this.hasBinamix && game.irs) {
                    let sadieDeg = (360 - targetDeg) % 360; 
                    let nearestAngle = Math.round(sadieDeg / 15) * 15;
                    if (nearestAngle === 360) nearestAngle = 0;

                    if (this.currentIrAngle !== nearestAngle && game.irs[nearestAngle]) {
                        this.currentIrAngle = nearestAngle;
                        const now = game.audioCtx.currentTime;
                        const fadeTime = 0.08; 
                        
                        try {
                            const activeGain = this.activeConv === 'A' ? this.gainA : this.gainB;
                            const inactiveGain = this.activeConv === 'A' ? this.gainB : this.gainA;
                            const inactiveConv = this.activeConv === 'A' ? this.convB : this.convA;

                            inactiveConv.buffer = game.irs[nearestAngle];
                            
                            activeGain.gain.cancelScheduledValues(now);
                            inactiveGain.gain.cancelScheduledValues(now);
                            
                            activeGain.gain.setValueAtTime(1, now);
                            inactiveGain.gain.setValueAtTime(0, now);
                            
                            activeGain.gain.linearRampToValueAtTime(0, now + fadeTime);
                            inactiveGain.gain.linearRampToValueAtTime(1, now + fadeTime);
                            
                            this.activeConv = this.activeConv === 'A' ? 'B' : 'A';
                        } catch (e) {}
                    }
                } else if (this.panner) {
                    // 💡 核心修正 3：備用 Panner 也拔除 bowAngle
                    let posX = Math.sin(this.angleRad) * this.dist;
                    let posZ = -Math.cos(this.angleRad) * this.dist;

                    const now = game.audioCtx.currentTime;
                    if (this.panner.positionX && typeof this.panner.positionX.setTargetAtTime === 'function') {
                        this.panner.positionX.setTargetAtTime(posX, now, 0.05);
                        this.panner.positionY.setTargetAtTime(0, now, 0.05);
                        this.panner.positionZ.setTargetAtTime(posZ, now, 0.05);
                    } else {
                        this.panner.setPosition(posX, 0, posZ);
                    }
                }
            }

            die(hit = false) {
                if (this.isDying) return;
                this.isDying = true;
                if (hit && game.audioCtx && game.masterCompressor) {
                    const ctx = game.audioCtx; const now = ctx.currentTime;
                    
                    let hitPanner = ctx.createPanner();
                    hitPanner.panningModel = 'HRTF';
                    
                    // 💡 修正 4：擊中時的特效音，也必須釘在目標的絕對座標上
                    hitPanner.setPosition(Math.sin(this.angleRad)*this.dist, 0, -Math.cos(this.angleRad)*this.dist);
                    
                    const pingOsc = ctx.createOscillator(); const pingGain = ctx.createGain();
                    pingOsc.type = 'sine'; pingOsc.frequency.setValueAtTime(2000 + Math.random()*500, now);
                    pingGain.gain.setValueAtTime(0.4, now); pingGain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
                    pingOsc.connect(pingGain); pingGain.connect(hitPanner);
                    
                    if (game.noiseBuffer) {
                        const noiseSrc = ctx.createBufferSource(); noiseSrc.buffer = game.noiseBuffer;
                        const noiseFilter = ctx.createBiquadFilter(); noiseFilter.type = 'highpass'; noiseFilter.frequency.value = 6000;
                        const noiseGain = ctx.createGain(); noiseGain.gain.setValueAtTime(0.3, now); noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
                        noiseSrc.connect(noiseFilter); noiseFilter.connect(noiseGain); noiseGain.connect(hitPanner);
                        noiseSrc.start(now); noiseSrc.stop(now + 0.2);
                    }
                    hitPanner.connect(game.masterCompressor); pingOsc.start(now); pingOsc.stop(now + 0.15); 
                    
                    for(let i=0; i<25; i++) {
                        const angle = Math.random() * Math.PI * 2;
                        const speed = 2 + Math.random() * 8;
                        game.particles.push({
                            x: this.x, y: this.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
                            life: 1.0, color: this.type.color, size: (Math.random() * 4 + 2) * game.uiScale
                        });
                    }
                    game.totalHits++;
                } else if (!hit) {
                    game.setUiState(prev => ({ ...prev, comboText: "💨 錯失目標...", comboColor: "#ff4444" }));
                }
                
                if (this.masterTargetGain && game.audioCtx) { try { this.masterTargetGain.gain.setTargetAtTime(0.0001, game.audioCtx.currentTime, 0.1); } catch(e) {} }
                setTimeout(() => { 
                    this.cleanup(); 
                    game.targetMole = null; 
                    game.targetsInLevel++;
                    if (game.targetsInLevel >= TARGETS_PER_LEVEL) {
                        if (game.currentLevel < 3) {
                            game.currentLevel++; game.targetsInLevel = 0; 
                            game.status = 'transition';
                            game.setUiState(prev => ({ ...prev, status: 'transition', transTitle: LEVEL_CONFIG[game.currentLevel].name, transSub: LEVEL_CONFIG[game.currentLevel].sub, transOpacity: 1 }));
                            setTimeout(() => {
                                game.setUiState(prev => ({ ...prev, transOpacity: 0 }));
                                setTimeout(() => {
                                    game.status = 'playing'; game.spawnTimer = 0; 
                                    game.setUiState(prev => ({ ...prev, status: 'playing', level: game.currentLevel, comboText: "準備迎擊！", comboColor: "#44ffaa" }));
                                }, 500);
                            }, 2500);
                        } else { 
                            game.status = 'gameover';
                            game.setUiState(prev => ({ ...prev, status: 'gameover', finalScore: game.score, finalEval: "狩獵結束，請檢視成績！" }));
                        }
                    }
                }, 800); 
            }

            cleanup() {
                this.nodes.forEach(n => { try { if(n.stop) n.stop(); } catch(e){} });
                if (this.convA) { try{this.convA.disconnect();}catch(e){} }
                if (this.convB) { try{this.convB.disconnect();}catch(e){} }
                if (this.gainA) { try{this.gainA.disconnect();}catch(e){} }
                if (this.gainB) { try{this.gainB.disconnect();}catch(e){} }
                if (this.binamixBoost) { try{this.binamixBoost.disconnect();}catch(e){} }
                if (this.panner) { try{this.panner.disconnect();}catch(e){} }
                if (this.wetGain) { try{this.wetGain.disconnect();}catch(e){} }
                if (this.synthBus) { try{this.synthBus.disconnect();}catch(e){} }
                if (this.masterTargetGain) { try{this.masterTargetGain.disconnect();}catch(e){} this.masterTargetGain = null; }
            }

            update() {
                this.pulse += 0.08;
                try { this.updateSpatialPosition(); } catch(e) {} 

                if (this.isDying) { this.scale -= 0.15; return; }
                if (this.state === 0) {
                    this.revealTimer--;
                    if (this.revealTimer <= 0) {
                        this.state = 1; 
                        game.setUiState(prev => ({ ...prev, comboText: "🎯 出現了！射擊！", comboColor: "#64dcff" }));
                    }
                } else if (this.state === 1) {
                    if (this.scale < 1.0) this.scale += 0.15; 
                    this.aliveTimer--;
                    if (this.aliveTimer <= 0) this.die(false); 
                }
                if (game.audioCtx && this.masterTargetGain && this.type.id === 'bell') {
                    const now = game.audioCtx.currentTime;
                    this.nodes.forEach(n => {
                        if (n.type === 'env' && now - n.lastTrigger > 1.0 + n.i*0.2) {
                            try { n.gain.gain.cancelScheduledValues(now); n.gain.gain.setTargetAtTime(1.0 / (n.i+1), now, 0.01); n.gain.gain.setTargetAtTime(0.0001, now + 0.1, 0.3); n.lastTrigger = now; } catch(e){}
                        }
                    });
                }
            }

            draw(ctx) {
                if (this.state === 0 || this.scale <= 0) return; 
                let currentSize = Math.max(2, 40 * game.uiScale * this.depthScale * this.scale); 
                if (this.type.id === 'bell' || this.type.id === 'rotor') currentSize *= 1.15; 
                let alpha = this.scale;
                if (this.aliveTimer < 40 && !this.isDying) alpha = Math.abs(Math.sin(this.pulse * 2.0)); 
                ctx.save(); ctx.translate(this.x, this.y); 
                const glowSize = Math.max(1, currentSize * 4.5);
                const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, glowSize);
                glow.addColorStop(0, `rgba(${this.type.color}, ${alpha * 0.6})`); glow.addColorStop(1, 'transparent');
                ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(0, 0, glowSize, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = `rgba(${this.type.color}, ${alpha})`; ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.9})`; 
                ctx.lineWidth = 2.0; ctx.lineJoin = 'round';
                if (this.type.id === 'bell') { 
                    ctx.beginPath(); ctx.arc(0, 0, Math.max(0.1, currentSize*0.6), Math.PI, 0); ctx.lineTo(currentSize*0.8, currentSize*0.5); ctx.lineTo(-currentSize*0.8, currentSize*0.5); ctx.closePath(); ctx.fill(); ctx.stroke();
                    ctx.beginPath(); ctx.arc(0, currentSize*0.7, Math.max(0.1, currentSize*0.2), 0, Math.PI*2); ctx.stroke();
                } else if (this.type.id === 'rotor') { 
                    ctx.rotate(this.pulse * 2.0); 
                    for(let i=0; i<4; i++) { ctx.rotate(Math.PI/2); ctx.beginPath(); ctx.ellipse(0, -currentSize*0.6, Math.max(0.1, currentSize*0.2), Math.max(0.1, currentSize*0.6), 0, 0, Math.PI*2); ctx.stroke(); }
                    ctx.beginPath(); ctx.arc(0, 0, Math.max(0.1, currentSize*0.3), 0, Math.PI*2); ctx.fill(); ctx.stroke();
                } else if (this.type.id === 'frog') { 
                    const pulseEye = Math.abs(Math.sin(this.pulse * 6)); 
                    ctx.beginPath(); ctx.ellipse(-currentSize*0.4, 0, Math.max(0.1, currentSize*0.4), Math.max(0.1, currentSize*0.3 * (1-pulseEye*0.5)), 0, 0, Math.PI*2); ctx.ellipse(currentSize*0.4, 0, Math.max(0.1, currentSize*0.4), Math.max(0.1, currentSize*0.3 * (1-pulseEye*0.5)), 0, 0, Math.PI*2); ctx.fill(); ctx.stroke();
                    ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(-currentSize*0.4, 0, Math.max(0.1, currentSize*0.1), 0, Math.PI*2); ctx.arc(currentSize*0.4, 0, Math.max(0.1, currentSize*0.1), 0, Math.PI*2); ctx.fill();
                } else if (this.type.id === 'wind') {
                    ctx.translate(-currentSize*0.6, 0);
                    for(let i=0; i<3; i++) { let yOff = (i-1) * currentSize*0.4; ctx.beginPath(); ctx.moveTo(0, yOff); ctx.bezierCurveTo(currentSize*0.6, yOff-currentSize*0.5, currentSize*0.6, yOff+currentSize*0.5, currentSize*1.2, yOff); ctx.stroke(); }
                }
                ctx.restore();
            }
        }

        class Arrow {
            constructor(angleRad) {
                this.angleRad = angleRad; this.dist = 0.5; 
                const coords = getMappedCoords(this.angleRad, this.dist);
                this.x = coords.x; this.y = coords.y;
                this.depthScale = coords.depthScale;
                this.distSpeed = 15.0 / 90.0; this.isDead = false;
                try { this.initAudio(); } catch(e){}
            }
            initAudio() {
                if (!game.audioCtx || !game.masterCompressor || !game.noiseBuffer) return;
                const ctx = game.audioCtx; const now = ctx.currentTime;
                this.gain = ctx.createGain(); 
                
                this.panner = ctx.createPanner();
                this.panner.panningModel = 'HRTF';
                this.panner.distanceModel = 'inverse';
                
                this.src = ctx.createBufferSource(); this.src.buffer = game.noiseBuffer; this.src.loop = true;
                this.filter = ctx.createBiquadFilter(); this.filter.type = 'bandpass'; this.filter.Q.value = 1.5;
                this.filter.frequency.setValueAtTime(6000, now); this.filter.frequency.exponentialRampToValueAtTime(300, now + 1.2); 
                this.src.connect(this.filter); this.filter.connect(this.panner);
                this.panner.connect(this.gain); this.gain.connect(game.masterCompressor); 
                
                this.gain.gain.setValueAtTime(0, now); 
                this.gain.gain.linearRampToValueAtTime(0.8, now + 0.05); 
                this.gain.gain.exponentialRampToValueAtTime(0.001, now + 1.2); 
                this.src.start(now);
            }
            update() {
                this.dist += this.distSpeed; 
                const coords = getMappedCoords(this.angleRad, this.dist);
                this.x = coords.x; this.y = coords.y;
                this.depthScale = coords.depthScale;
                
                if (this.panner && game.audioCtx) {
                    // 💡 修正 5：飛行中的箭矢聲音，也必須沿著自己的絕對軌跡 (this.angleRad) 發聲
                    let posX = Math.sin(this.angleRad) * this.dist;
                    let posZ = -Math.cos(this.angleRad) * this.dist;
                    if (this.panner.positionX) {
                        const now = game.audioCtx.currentTime;
                        this.panner.positionX.setTargetAtTime(posX, now, 0.05);
                        this.panner.positionZ.setTargetAtTime(posZ, now, 0.05);
                    } else {
                        this.panner.setPosition(posX, 0, posZ);
                    }
                }

                if (game.targetMole && game.targetMole.state === 1 && !game.targetMole.isDying) {
                    const coordsT = getMappedCoords(game.targetMole.angleRad, game.targetMole.dist);
                    const dx3d = coords.px - coordsT.px; const dz3d = coords.pz - coordsT.pz;
                    if (Math.sqrt(dx3d*dx3d + dz3d*dz3d) < 2.0) { 
                        game.targetMole.die(true); 
                        this.die(); 
                        game.score += 100 * game.currentLevel; 
                        game.setUiState(prev => ({ ...prev, score: game.score, comboText: "🎯 精準命中！", comboColor: "#44ffaa" }));
                    }
                }
                if (this.dist > 15.0) this.die();
            }
            die() {
                this.isDead = true;
                if (this.gain && game.audioCtx) { try { this.gain.gain.setTargetAtTime(0.0001, game.audioCtx.currentTime, 0.05); setTimeout(() => { try{this.src.stop();}catch(e){} this.gain.disconnect(); }, 200); } catch(e){} }
            }
            draw(ctx) {
                if(isNaN(this.x) || isNaN(this.y)) return;
                ctx.save(); ctx.translate(this.x, this.y); ctx.rotate(this.angleRad); ctx.scale(this.depthScale, this.depthScale);
                ctx.strokeStyle = '#44ffaa'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(0, 15*game.uiScale); ctx.lineTo(0, -15*game.uiScale); ctx.stroke();
                ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(0, -20*game.uiScale); ctx.lineTo(6*game.uiScale, -10*game.uiScale); ctx.lineTo(-6*game.uiScale, -10*game.uiScale); ctx.closePath(); ctx.fill();
                ctx.shadowBlur = 10; ctx.shadowColor = '#44ffaa'; ctx.strokeStyle = 'rgba(68, 255, 170, 0.3)'; ctx.beginPath(); ctx.moveTo(0, 15*game.uiScale); ctx.lineTo(0, 40*game.uiScale); ctx.stroke(); ctx.restore();
            }
        }

        // --- 控制邏輯 ---
        function triggerBowImpulse(angle) {
            if (!game.audioCtx || !game.masterCompressor || !game.noiseBuffer) return;
            try {
                const ctx = game.audioCtx; const now = ctx.currentTime;
                let panner = ctx.createPanner();
                panner.panningModel = 'HRTF';
                let posX = Math.sin(angle) * 1.5;
                let posZ = -Math.cos(angle) * 1.5;
                panner.setPosition(posX, 0, posZ);

                const src = ctx.createBufferSource(); src.buffer = game.noiseBuffer;
                const filter = ctx.createBiquadFilter(); filter.type = 'bandpass'; filter.frequency.value = 4000; filter.Q.value = 5.0;
                const gain = ctx.createGain(); gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(0.08, now + 0.002); gain.gain.exponentialRampToValueAtTime(0.001, now + 0.03); 
                src.connect(filter); filter.connect(gain); gain.connect(panner); panner.connect(game.masterCompressor); 
                src.start(now); src.stop(now + 0.05);
            } catch(e) { }
        }

        function updateBowAudio() {
            let targetAngle = Math.atan2(game.pointerX - game.centerX, game.listenerPlaneY - game.pointerY); 
            if(isNaN(targetAngle)) targetAngle = 0;
            let delta = targetAngle - game.bowAngle;
            while (delta > Math.PI) delta -= Math.PI * 2;
            while (delta < -Math.PI) delta += Math.PI * 2;
            game.bowAngle += delta * 0.2; 
            
            if (game.audioCtx && game.status === 'playing') {
                const angularVelocity = Math.abs(game.bowAngle - game.lastBowAngle);
                game.rotationAccumulator += angularVelocity;
                if (game.rotationAccumulator > 0.06) {
                    let ticks = Math.floor(game.rotationAccumulator / 0.06);
                    game.rotationAccumulator -= ticks * 0.06;
                    for(let i=0; i<Math.min(2, ticks); i++) triggerBowImpulse(game.bowAngle);
                }
            }
            game.lastBowAngle = game.bowAngle;
        }

        function drawSafeBackground() {
            const bgGrad = ctx.createRadialGradient(game.centerX, game.listenerPlaneY, 0, game.centerX, game.listenerPlaneY, game.height);
            bgGrad.addColorStop(0, '#021020'); bgGrad.addColorStop(1, '#000000');
            ctx.fillStyle = bgGrad; ctx.fillRect(0, 0, game.width, game.height);
            ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0, 204, 255, 0.15)';
            for (let i = -4; i <= 4; i++) { const a = (i * 15) * Math.PI / 180; ctx.beginPath(); ctx.moveTo(game.centerX, game.listenerPlaneY); ctx.lineTo(game.centerX + Math.sin(a) * game.width, game.listenerPlaneY - Math.cos(a) * game.height); ctx.stroke(); }
            [2, 4, 6, 8, 10, 12, 14].forEach(d => { ctx.beginPath(); for (let a = -Math.PI/2; a <= Math.PI/2; a += 0.1) { const c = getMappedCoords(a, d); if (a === -Math.PI/2) ctx.moveTo(c.x, c.y); else ctx.lineTo(c.x, c.y); } ctx.stroke(); });
            ctx.save(); ctx.shadowBlur = 20; ctx.shadowColor = 'rgba(0,204,255,0.3)'; ctx.fillStyle = 'rgba(0,204,255,0.1)'; ctx.strokeStyle = 'rgba(0,204,255,0.5)'; ctx.beginPath(); ctx.ellipse(game.centerX, game.listenerPlaneY, 40*game.uiScale, 15*game.uiScale, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.restore();
        }

        function animate() {
            try {
                drawSafeBackground();

                if (game.status === 'playing') {
                    try { updateBowAudio(); } catch(e) {}

                    try {
                        const time = Date.now() * 0.003;
                        for(let i = 1; i <= 35; i++) {
                            const pt1 = getMappedCoords(game.bowAngle, (i-1)*0.35); const pt2 = getMappedCoords(game.bowAngle, i*0.35-0.1);
                            ctx.beginPath(); ctx.moveTo(pt1.x, pt1.y); ctx.lineTo(pt2.x, pt2.y);
                            ctx.lineWidth = Math.max(0.5, 4 * game.uiScale * pt1.depthScale); 
                            ctx.strokeStyle = `hsla(${(i*10-time*50)%360}, 100%, 65%, ${(Math.sin(i*0.4-time*4)+1)/2})`;
                            ctx.stroke();
                        }
                    } catch(e) {}

                    try {
                        ctx.save(); ctx.translate(game.centerX, game.listenerPlaneY); ctx.rotate(game.bowAngle);
                        if (game.recoilTime > 0) { ctx.translate(0, 5 * game.uiScale); game.recoilTime--; }
                        ctx.strokeStyle = '#ffaa44'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(0, 0, 40 * game.uiScale, Math.PI + 0.5, 2 * Math.PI - 0.5); ctx.stroke();
                        ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(Math.cos(Math.PI+0.5)*40*game.uiScale, Math.sin(Math.PI+0.5)*40*game.uiScale);
                        ctx.lineTo(0, 10*game.uiScale); ctx.lineTo(Math.cos(2*Math.PI-0.5)*40*game.uiScale, Math.sin(2*Math.PI-0.5)*40*game.uiScale); ctx.stroke();
                        ctx.strokeStyle = '#64dcff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(0, 10*game.uiScale); ctx.lineTo(0, -35*game.uiScale); ctx.stroke();
                        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(0, -45*game.uiScale); ctx.lineTo(5*game.uiScale, -35*game.uiScale); ctx.lineTo(-5*game.uiScale, -35*game.uiScale); ctx.closePath(); ctx.fill();
                        ctx.restore();
                    } catch (e) {}

                    try {
                        if (!game.targetMole) {
                            game.spawnTimer++;
                            if (game.spawnTimer > 60) { game.targetMole = new TargetMole(); game.spawnTimer = 0; }
                        }
                    } catch(e) {}
                    
                    try {
                        for (let i = game.particles.length - 1; i >= 0; i--) {
                            let p = game.particles[i]; p.x += p.vx; p.y += p.vy; p.life -= 0.03;
                            ctx.globalAlpha = Math.max(0, p.life); ctx.fillStyle = `rgba(${p.color}, ${p.life})`;
                            ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI*2); ctx.fill();
                            if (p.life <= 0) game.particles.splice(i, 1);
                        }
                        ctx.globalAlpha = 1.0;
                    } catch(e) {}

                    try {
                        for (let i = game.arrows.length - 1; i >= 0; i--) { game.arrows[i].update(); game.arrows[i].draw(ctx); if (game.arrows[i].isDead) game.arrows.splice(i, 1); }
                        if (game.targetMole) { game.targetMole.update(); game.targetMole.draw(ctx); }
                    } catch(e) {}
                    
                    try {
                        ctx.save(); ctx.translate(game.pointerX, game.pointerY); ctx.strokeStyle = game.recoilTime > 0 ? '#ff4444' : 'rgba(100, 220, 255, 0.8)'; ctx.lineWidth = 2; const r = game.recoilTime > 0 ? 15*game.uiScale : 20*game.uiScale; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI*2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-r*1.5, 0); ctx.lineTo(-r*0.5, 0); ctx.moveTo(r*1.5, 0); ctx.lineTo(r*0.5, 0); ctx.moveTo(0, -r*1.5); ctx.lineTo(0, -r*0.5); ctx.moveTo(0, r*1.5); ctx.lineTo(0, r*0.5); ctx.stroke(); ctx.restore();
                    } catch(e) {}
                }

                if (game.status === 'playing') {
                    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'; ctx.fillRect(5, 5, 220, 60);
                    ctx.fillStyle = '#44ffaa'; ctx.font = '12px monospace'; ctx.textAlign = 'left';
                    ctx.fillText(`Pointer: ${Math.round(game.pointerX)}, ${Math.round(game.pointerY)}`, 15, 20);
                    ctx.fillText(`BowAngle: ${game.bowAngle.toFixed(3)}`, 15, 35);
                    const loadedCount = game.irs ? Object.keys(game.irs).length : 0;
                    ctx.fillText(`Binamix IR: ${loadedCount}/24 ${loadedCount === 0 ? '(Fallback)' : ''}`, 15, 50);
                }

            } catch(e) { }
            game.animFrameId = requestAnimationFrame(animate);
        }

        const handlePointerMove = (e) => { game.pointerX = e.clientX; game.pointerY = e.clientY; };
        const handlePointerDown = (e) => { 
            game.pointerX = e.clientX; game.pointerY = e.clientY;
            if (game.status === 'playing' && !isNaN(game.bowAngle)) { 
                game.arrows.push(new Arrow(game.bowAngle)); 
                game.recoilTime = 10; 
                if (game.audioCtx && game.masterCompressor) { 
                    try { 
                        const tOsc = game.audioCtx.createOscillator(); const tGain = game.audioCtx.createGain(); 
                        tOsc.type = 'triangle'; tOsc.frequency.setValueAtTime(150, game.audioCtx.currentTime); tOsc.frequency.exponentialRampToValueAtTime(50, game.audioCtx.currentTime + 0.2); 
                        tGain.gain.setValueAtTime(0.5, game.audioCtx.currentTime); tGain.gain.exponentialRampToValueAtTime(0.001, game.audioCtx.currentTime + 0.3); 
                        tOsc.connect(tGain); tGain.connect(game.masterCompressor); tOsc.start(); tOsc.stop(game.audioCtx.currentTime + 0.3); 
                    } catch(e){} 
                } 
            } 
        };

        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerdown', handlePointerDown);
        window.addEventListener('resize', initLayout);

        initLayout();
        animate();

        return () => {
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerdown', handlePointerDown);
            window.removeEventListener('resize', initLayout);
            cancelAnimationFrame(game.animFrameId);
        };
    }, []);

    // === 非同步載入 Binamix 音訊與生成空間殘響 ===
    const unlockAudioAndStart = async () => {
        const game = engine.current;
        if (game.status !== 'locked') return;
        
        game.status = 'loading';
        setUiState(prev => ({ ...prev, status: 'loading' }));
        
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            game.audioCtx = ctx;
            game.masterCompressor = ctx.createDynamicsCompressor();
            game.masterCompressor.threshold.value = -16;
            game.masterCompressor.ratio.value = 6;
            game.masterCompressor.connect(ctx.destination);
            
            // 1. 生成噪音基底
            game.noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
            const output = game.noiseBuffer.getChannelData(0);
            for (let i = 0; i < output.length; i++) output[i] = Math.random() * 2 - 1;

            // 2. 生成深海殘響空間
            game.envConvolver = ctx.createConvolver();
            game.envConvolver.connect(game.masterCompressor);
            const sampleRate = ctx.sampleRate;
            const frameCount = Math.floor(sampleRate * 1.5); 
            const buffer = ctx.createBuffer(2, frameCount, sampleRate);
            const filterAlpha = Math.min(1.0, (2 * Math.PI * 8000) / sampleRate);
            let rmsSum = 0;
            for (let ch = 0; ch < 2; ch++) {
                const data = buffer.getChannelData(ch); 
                let lastVal = 0;
                for (let i = 0; i < frameCount; i++) {
                    lastVal += filterAlpha * ((Math.random() * 2 - 1) - lastVal); 
                    data[i] = lastVal * Math.exp(-4.0 * (i/sampleRate));
                    rmsSum += data[i] * data[i];
                }
            }
            const normalizeFactor = 0.05 / (Math.sqrt(rmsSum / (frameCount * 2)) || 1);
            for (let ch = 0; ch < 2; ch++) {
                const data = buffer.getChannelData(ch);
                for (let i = 0; i < frameCount; i++) data[i] *= normalizeFactor;
            }
            game.envConvolver.buffer = buffer;

            // 3. 批次下載 Binamix HRTF 檔案
            game.irs = {};
            const angles = Array.from({ length: 24 }, (_, i) => i * 15);
            let loaded = 0;

            await Promise.all(angles.map(async (a) => {
                try {
                    const res = await fetch(`/audio/irs/ir_${a}.wav`);
                    if (res.ok) {
                        const arrayBuffer = await res.arrayBuffer();
                        const decoded = await ctx.decodeAudioData(arrayBuffer);
                        if (decoded) {
                            game.irs[a] = decoded;
                            loaded++;
                            setUiState(prev => ({ ...prev, irLoadedCount: loaded }));
                        }
                    }
                } catch (err) { }
            }));
            
            console.log(`Binamix 3D HRTF 載入完成！共 ${loaded} 個方位`);
            if (ctx.state === 'suspended') await ctx.resume();
        } catch (e) { console.error("Audio Init Failed", e); }

        game.status = 'menu';
        setUiState(prev => ({ ...prev, status: 'menu' }));
    };

    const startGame = () => {
        const game = engine.current;
        game.score = 0; game.totalHits = 0; game.currentLevel = 1; game.targetsInLevel = 0;
        setUiState(prev => ({ ...prev, score: 0 }));
        
        game.status = 'transition';
        game.targetMole = null; game.arrows = []; game.particles = []; game.spawnTimer = 0;
        setUiState(prev => ({ 
            ...prev, status: 'transition', transTitle: LEVEL_CONFIG[game.currentLevel].name, transSub: LEVEL_CONFIG[game.currentLevel].sub, transOpacity: 1 
        }));
        
        setTimeout(() => {
            setUiState(prev => ({ ...prev, transOpacity: 0 }));
            setTimeout(() => {
                game.status = 'playing'; game.spawnTimer = 0; 
                setUiState(prev => ({ ...prev, status: 'playing', level: game.currentLevel, comboText: "準備迎擊！", comboColor: "#44ffaa" }));
            }, 500);
        }, 2500);
    };

    return (
        <div style={{ width: '100vw', height: '100vh', overflow: 'hidden', backgroundColor: '#01050a', userSelect: 'none', WebkitUserSelect: 'none', touchAction: 'none', position: 'relative', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' }}>
            <style>{`
                * { cursor: crosshair !important; }
                .pulse-circle { width: 80px; height: 80px; border-radius: 50%; background: rgba(100, 220, 255, 0.2); animation: pulse 1.5s infinite; margin-bottom: 20px; border: 2px solid #64dcff; }
                @keyframes pulse { 0% { transform: scale(0.9); box-shadow: 0 0 0 0 rgba(100, 220, 255, 0.7); } 70% { transform: scale(1.1); box-shadow: 0 0 0 20px rgba(100, 220, 255, 0); } 100% { transform: scale(0.9); box-shadow: 0 0 0 0 rgba(100, 220, 255, 0); } }
                .action-btn { background: rgba(100, 220, 255, 0.15); border: 2px solid #64dcff; color: #64dcff; padding: 15px 40px; border-radius: 30px; font-weight: bold; font-size: 18px; letter-spacing: 2px; transition: all 0.2s; text-align: center; margin-top: 20px; outline: none; }
                .action-btn:hover { filter: brightness(1.5) drop-shadow(0 0 20px #64dcff); background: rgba(100, 220, 255, 0.3); }
                .action-btn:active { transform: scale(0.95); }
                .modal-box { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); display: flex; flex-direction: column; gap: 15px; z-index: 200; background: rgba(5, 15, 25, 0.95); padding: 40px 60px; border-radius: 24px; border: 1px solid rgba(100,220,255,0.3); text-align: center; box-shadow: 0 20px 50px rgba(0,0,0,0.8); pointer-events: auto; }
            `}</style>

            <canvas ref={canvasRef} style={{ position: 'absolute', top: 0, left: 0, zIndex: 10, display: 'block', width: '100%', height: '100%' }} />

            {(uiState.status === 'locked' || uiState.status === 'loading') && (
                <div 
                    style={{ position: 'absolute', top: 0, left: 0, width: '100vw', height: '100vh', backgroundColor: '#01050a', zIndex: 100000, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', color: '#64dcff', cursor: 'pointer' }}
                    onClick={uiState.status === 'locked' ? unlockAudioAndStart : undefined}
                >
                    <div className="pulse-circle"></div>
                    <h2 style={{ letterSpacing: '2px' }}>
                        {uiState.status === 'locked' ? '音訊引擎準備就緒' : '正在讀取 Binamix 空間音訊...'}
                    </h2>
                    <p style={{ opacity: 0.8 }}>
                        {uiState.status === 'locked' ? '請點擊螢幕開啟 3D 聲場' : `即將完成... (${uiState.irLoadedCount}/24)`}
                    </p>
                </div>
            )}

            {uiState.status === 'menu' && (
                <div className="modal-box">
                    <div style={{ color: '#fff', fontSize: '36px', marginBottom: '10px', letterSpacing: '2px', textShadow: '0 0 20px rgba(100,220,255,0.8)' }}>深海神射手 - 專業訓練版</div>
                    <div style={{ color: 'rgba(255,255,255,0.8)', fontSize: '15px', marginBottom: '10px', lineHeight: '1.8', textAlign: 'left', padding: '0 20px' }}>
                        🎧 <b>Binamix 搭載：</b>遊戲現已升級真實 HRTF 聲學追蹤系統。<br/>
                        🎮 <b>三階挑戰：</b>共 15 題，給予充裕的時間進行聽覺空間定位。<br/>
                        🦇 <b>盲聽索敵：</b>聲音領先畫面出現，先聽方位，後看目標。<br/>
                        (強烈建議：請務必配戴雙聲道耳機進行訓練)
                    </div>
                    <button className="action-btn" onClick={startGame}>開始狩獵</button>
                </div>
            )}

            {uiState.status === 'gameover' && (
                <div className="modal-box">
                    <div style={{ color: '#fff', fontSize: '36px', marginBottom: '10px', letterSpacing: '2px', textShadow: '0 0 20px rgba(100,220,255,0.8)' }}>狩獵結束</div>
                    <div style={{ fontSize: '64px', color: '#ffaa44', fontWeight: 'bold', margin: '10px 0', textShadow: '0 0 20px rgba(255,170,68,0.8)' }}>{uiState.finalScore}</div>
                    <div style={{ fontSize: '20px', color: '#44ffaa', lineHeight: '1.6', marginBottom: '10px' }}>{uiState.finalEval}</div>
                    <button className="action-btn" style={{ borderColor: '#44ffaa', color: '#44ffaa' }} onClick={startGame}>再次挑戰</button>
                </div>
            )}

            {uiState.status === 'transition' && (
                <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', color: '#fff', fontSize: '48px', fontWeight: 'bold', letterSpacing: '4px', textShadow: '0 0 30px rgba(100, 220, 255, 0.8)', zIndex: 300, pointerEvents: 'none', textAlign: 'center', transition: 'opacity 0.5s', opacity: uiState.transOpacity }}>
                    <div>{uiState.transTitle}</div>
                    <div style={{ fontSize: '20px', fontWeight: 'normal', color: '#ffaa44', marginTop: '10px', letterSpacing: '2px' }}>{uiState.transSub}</div>
                </div>
            )}

            {uiState.status === 'playing' && (
                <div style={{ position: 'absolute', top: '25px', left: '30px', zIndex: 100, pointerEvents: 'none' }}>
                    <div style={{ color: '#fff', fontSize: '18px', opacity: 0.8, letterSpacing: '1px', marginBottom: '5px' }}>關卡 {uiState.level} / 3</div>
                    <div style={{ color: '#ffaa44', fontSize: '32px', fontWeight: 'bold', textShadow: '0 0 15px rgba(255,170,68,0.8)', marginBottom: '5px', letterSpacing: '2px' }}>SCORE: {uiState.score}</div>
                    <div style={{ color: uiState.comboColor, fontSize: '18px', opacity: 0.8 }}>{uiState.comboText}</div>
                </div>
            )}
        </div>
    );
}