# Sales-Weaving Helper

เว็บแอปสำหรับฝ่ายขาย + ฝ่ายวางแผนโรงงานทอผ้า ดึงข้อมูล Live จาก Google Sheets ผ่าน CSV

## โครงสร้างไฟล์

```
index.html  — HTML โครงสร้างหน้าเพจ (แก้ UI ที่นี่)
app.js      — Logic ทั้งหมด (แก้ bug / feature ที่นี่)
style.css   — Custom CSS (Tailwind ใช้ CDN ไม่อยู่ในนี้)
```

## Data Source

Google Sheets CSV — URL อยู่ใน `app.js` บรรทัดแรก (`CSV_URL`)  
Fallback: `data.csv` ในโฟลเดอร์เดียวกัน

## Key Globals (app.js)

| ตัวแปร | ความหมาย |
|---|---|
| `rawData` | ทุก row จาก CSV หลัง clean |
| `window.fabricCache` | index ของ Weaving Item แต่ละสเปก (prebuilt) |
| `_fabricSearchIndex` | cache สำหรับ fuzzy search (null = ยังไม่ build) |

## Helper Functions (app.js)

| ฟังก์ชัน | ทำอะไร |
|---|---|
| `getMinMaxCtrl(jobs)` | ดึง Min/Max/midPoint จาก job list |
| `getControlStrategyTag(ctrl)` | render badge "Min/Max Ctrl" หรือ "By Order" |
| `calcLeadTimeDays(jobs)` | คำนวณ lead time จาก job ล่าสุด |
| `calculateDailyRunningBalance(...)` | simulate สต็อกรายวัน |
| `jsArg(v)` | serialize ค่าสำหรับใส่ใน onclick attribute (ป้องกัน XSS) |
| `showToast(msg)` | แสดง toast notification |

## Constants (app.js)

- `METERS_PER_MC_PER_DAY = 2500` — ค่าผลิต meter ต่อเครื่องต่อวัน

## Page Navigation

หน้าทั้งหมดใช้ `navigate('page-id')` สลับ section:

| page-id | หน้า |
|---|---|
| `menu` | แผงควบคุมหลัก |
| `fabric-check` | เช็คม้วนผืนผ้า (Ledger) |
| `usage-stats` | วิเคราะห์ภาพรวม |
| `rec-role-select` | เลือก Role ก่อนแนะนำผ้า |
| `stock-recommend` | แนะนำผืนผ้า |
| `rec-spec-detail` | รายละเอียดสเปก |

## Conventions

- onclick ที่รับ dynamic value ต้องใช้ `jsArg()` เสมอ — ห้ามใช้ string interpolation ตรงๆ
- Column name จาก CSV เป็นภาษาไทย เช่น `'ใช้ผ้า'`, `'เลขที่ CO'`, `'ฝ่ายขาย'`
- Filter fields (`Wildth`, `Denia`, `Frequency`, `Pattern`) ต้องตรงกับชื่อคอลัมน์ CSV
- `Wildth` เป็นชื่อคอลัมน์ใน CSV จริง (ไม่ใช่ typo ในโค้ด — แสดงผลเป็น "Width")
