# 🌴 Weather Dashboard - แปลงมะพร้าวคลองวาฬ

Live weather dashboard สำหรับแปลงมะพร้าวคลองวาฬ (อ.สามร้อยยอด จ.ประจวบคีรีขันธ์)

**🌐 Live:** https://nub-1.github.io/khlongwan-weather/

## ✨ Features

- 🌧️ **ฝนปัจจุบัน** — Longdo Weather API (real-time rain intensity)
- 💨 **ลม** — Longdo Weather Wind API
- 📊 **กราฟ 14 วัน** — Open-Meteo Forecast (ฝน, อุณหภูมิ, ความชื้น)
- 📈 **สถิติย้อนหลัง** — Open-Meteo Archive (15 วันที่ผ่านมา)
- 📡 **เรดาร์ฝนสด** — Longdo rain radar tiles (observed + forecast)
- 📱 Responsive — ดูได้ทั้งมือถือและคอม

## 🛠️ Tech Stack

- **Frontend:** HTML + Vanilla JS + Chart.js (CDN)
- **Data sources:**
  - [Longdo Weather API](https://weather.longdo.com/) — rain + wind (API key required)
  - [Open-Meteo](https://open-meteo.com/) — forecast + archive (free, no key)
- **Hosting:** GitHub Pages (static, no backend needed)

## 🔑 API Key

Longdo API key อยู่ใน `index.html` (line 328) — เป็น free tier (10,000 calls/month)
ใครอยาก fork ไปใช้เอง ก็แก้ `LONGDO_KEY` เป็น key ของตัวเองได้เลย

> ⚠️ **หมายเหตุด้านความปลอดภัย:** key จะโผล่ใน source เนื่องจาก GitHub Pages เป็น static hosting
> ถ้าต้องการซ่อน key → ใช้ Cloudflare Pages + Worker หรือ deploy ผ่าน proxy อื่น

## 🏃 Local Development

แค่เปิดไฟล์ `index.html` ใน browser ก็ใช้ได้เลย (ไม่ต้อง server):

```bash
# macOS
open index.html

# Linux
xdg-open index.html

# หรือ
python3 -m http.server 8000
# แล้วเปิด http://localhost:8000
```

## 📍 Location

```
Latitude:  11.7563340
Longitude: 99.7684976
Place:     แปลงมะพร้าวคลองวาฬ, อ.สามร้อยยอด, จ.ประจวบคีรีขันธ์
```

## 🧑‍💻 Maintainer

- GitHub: [@Nub-1](https://github.com/Nub-1)
- Built with 💖 by [Mew AI Assistant](https://github.com)

---

🌴 *"ดูฟ้าฝน ให้รู้ทัน ก่อนลงแปลง"*