const Stopwatch = {
    t0: 0, elapsed: 0, running: false, req: null, laps: [],
    display: document.getElementById('sw-display'),
    lapsDiv: document.getElementById('sw-laps'),
    btnMain: document.getElementById('sw-btn'),
    btnSub: document.getElementById('sw-lap-reset-btn'),
    txtSub: document.getElementById('sw-lap-text'),

    trackingEnabled: false,
    watchId: null,
    totalDistance: 0,
    lastPos: null,
    speedEl: document.getElementById('sw-speed'),
    distEl: document.getElementById('sw-distance'),
    statsDiv: document.getElementById('sw-tracking-stats'),

    init() {
        this.render(0);
        this.updateSubBtn();
        const saved = localStorage.getItem('sw_tracking_enabled');
        if (saved === 'true') {
            this.toggleTracking(true);
        }
        this.updateTrackingUI(0, 0);

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && this.running) {
                this.elapsed = Date.now() - this.t0;
                this.render(this.elapsed);
            }
        });
    },

    toggle() { if (this.running) this.stop(); else this.start(); },

    start() {
        AudioMgr.init();
        Background.startPersistence();
        this.running = true;
        this.t0 = Date.now() - this.elapsed;
        const loop = () => {
            if (!this.running) return;
            this.elapsed = Date.now() - this.t0;
            this.render(this.elapsed);
            this.req = requestAnimationFrame(loop);
        };
        this.req = requestAnimationFrame(loop);
        this.btnMain.innerHTML = `<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
        this.display.classList.add('active-accent');
        this.updateSubBtn();
        if (this.trackingEnabled) this.startTracking();
    },

    stop() {
        this.running = false;
        if (this.req) cancelAnimationFrame(this.req);
        this.elapsed = Date.now() - this.t0;
        this.render(this.elapsed);
        this.btnMain.innerHTML = `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;
        this.display.classList.remove('active-accent');
        this.updateSubBtn();
        this.stopTracking();
        this.updateTrackingUI(0, 0);
        Background.stopPersistence();
    },

    lapOrReset() {
        if (this.running) this.lap(); else this.reset();
    },

    lap() {
        if (this.running) {
            this.elapsed = Date.now() - this.t0;
        }
        const now = this.elapsed;
        const last = this.laps.length > 0 ? this.laps[0].total : 0;
        const split = now - last;
        this.laps.unshift({ no: this.laps.length + 1, split, total: now });
        this.renderLaps();
        this.lapsDiv.style.display = 'block';
    },

    reset() {
        this.elapsed = 0;
        this.laps = [];
        this.render(0);
        this.renderLaps();
        this.lapsDiv.style.display = 'none';
        this.updateSubBtn();
        this.totalDistance = 0;
        this.lastPos = null;
        this.updateTrackingUI(0, 0);
    },

    updateSubBtn() {
        if (this.running) { this.txtSub.textContent = 'Lap'; this.btnSub.style.opacity = '1'; }
        else if (this.elapsed > 0) { this.txtSub.textContent = 'Reset'; this.btnSub.style.opacity = '1'; }
        else { this.txtSub.textContent = 'Reset'; this.btnSub.style.opacity = '0.3'; }
    },

    render(ms) {
        const h = Math.floor(ms / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        const mm = Math.floor((ms % 1000) / 10);
        let str = "";
        if (h > 0) str += h.toString().padStart(2, '0') + ":";
        str += m.toString().padStart(2, '0') + ":" + s.toString().padStart(2, '0') + "." + mm.toString().padStart(2, '0');
        this.display.textContent = str;
    },

    renderLaps() {
        this.lapsDiv.innerHTML = this.laps.map(l => {
            return `<div class="lap-row">
                <span>Lap ${l.no}</span>
                <span>${this.formatTime(l.split)}</span>
                <span>${this.formatTime(l.total)}</span>
            </div>`;
        }).join('');
    },

    formatTime(ms) {
        const h = Math.floor(ms / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        const mm = Math.floor((ms % 1000) / 10);
        let res = "";
        if (h > 0) res += h.toString().padStart(2, '0') + ":";
        res += m.toString().padStart(2, '0') + ":" + s.toString().padStart(2, '0') + "." + mm.toString().padStart(2, '0');
        return res;
    },

    toggleTracking(force = null) {
        this.trackingEnabled = (force !== null) ? force : !this.trackingEnabled;
        if (this.statsDiv) this.statsDiv.style.display = this.trackingEnabled ? 'grid' : 'none';
        localStorage.setItem('sw_tracking_enabled', this.trackingEnabled);

        if (this.trackingEnabled && this.running) {
            this.startTracking();
        } else {
            this.stopTracking();
        }
    },

    startTracking() {
        if (!navigator.geolocation) {
            this.trackingEnabled = false;
            if (this.statsDiv) this.statsDiv.style.display = 'none';
            return;
        }
        this.stopTracking();
        try {
            this.watchId = navigator.geolocation.watchPosition(
                (pos) => this.handlePosition(pos),
                (err) => console.warn('Geo Error:', err),
                { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
            );
        } catch (e) {
            console.warn('Geolocation Error:', e);
        }
    },

    stopTracking() {
        if (this.watchId) {
            navigator.geolocation.clearWatch(this.watchId);
            this.watchId = null;
        }
        this.lastPos = null;
    },

    handlePosition(pos) {
        if (!this.running) return;
        const { latitude, longitude, speed } = pos.coords;
        if (this.lastPos) {
            const d = this.calcDistance(this.lastPos.lat, this.lastPos.lon, latitude, longitude);
            if (d > 2) this.totalDistance += d;
        }
        this.lastPos = { lat: latitude, lon: longitude };
        const mph = (speed || 0) * 2.23694;
        const miles = this.totalDistance * 0.000621371;
        this.updateTrackingUI(mph, miles);
    },

    calcDistance(lat1, lon1, lat2, lon2) {
        const R = 6371e3;
        const φ1 = lat1 * Math.PI / 180;
        const φ2 = lat2 * Math.PI / 180;
        const Δφ = (lat2 - lat1) * Math.PI / 180;
        const Δλ = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    },

    updateTrackingUI(mph, miles) {
        if (this.speedEl) { this.speedEl.textContent = (mph > 0.1) ? mph.toFixed(1) : "0"; }
        if (this.distEl) { this.distEl.textContent = (miles > 0.005) ? miles.toFixed(2) : "0"; }
    }
};
