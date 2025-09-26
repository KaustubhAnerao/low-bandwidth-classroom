// ✅ FIX: Changed to a default export to match the import in main.js
const dbManager = {
    db: null,
    init() {
        return new Promise((resolve, reject) => {
            if (this.db) return resolve();
            const request = indexedDB.open("slidesDB", 1);
            request.onerror = (event) => reject("IndexedDB error: " + event.target.errorCode);
            request.onsuccess = (event) => { this.db = event.target.result; resolve(); };
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('slides')) {
                    db.createObjectStore('slides', { keyPath: 'id' });
                }
            };
        });
    },
    async storeSlide(sessionId, slideNum, blob) {
        await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['slides'], 'readwrite');
            const request = transaction.objectStore('slides').put({ id: `${sessionId}-slide-${slideNum}`, image: blob });
            request.onsuccess = () => resolve();
            request.onerror = (event) => reject('Failed to store slide: ' + event.target.error);
        });
    },
    async getSlide(sessionId, slideNum) {
        await this.init();
        return new Promise((resolve, reject) => {
            const request = this.db.transaction(['slides'], 'readonly').objectStore('slides').get(`${sessionId}-slide-${slideNum}`);
            request.onsuccess = (event) => {
                if (event.target.result) resolve(event.target.result.image);
                else reject('Slide not found in local storage.');
            };
            request.onerror = (event) => reject('Failed to get slide: ' + event.target.error);
        });
    },
    async isSessionDownloaded(sessionId, slideCount) {
         await this.init();
         if (slideCount === 0) return true;
         return new Promise((resolve) => {
            const request = this.db.transaction(['slides'], 'readonly').objectStore('slides').get(`${sessionId}-slide-${slideCount}`);
            request.onsuccess = (event) => resolve(!!event.target.result);
            request.onerror = () => resolve(false);
        });
    }
};

export default dbManager;

