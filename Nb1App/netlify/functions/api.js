const { neon } = require('@neondatabase/serverless');
const { google } = require('googleapis');

exports.handler = async (event) => {
    // ป้องกัน Error กรณีเรียกด้วย Method อื่นที่ไม่ใช่ POST
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ success: false, message: 'Method Not Allowed' }) };
    }

    // ใช้ NETLIFY_DATABASE_URL ตามที่คุณแคปภาพมา (หรือเผื่อไว้ใช้ DATABASE_URL)
    const dbUrl = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!dbUrl) {
        return { statusCode: 500, body: JSON.stringify({ success: false, message: 'Database URL is missing' }) };
    }

    const sql = neon(dbUrl);
    
    try {
        const body = JSON.parse(event.body);
        const { action, payload } = body;

        // 1. ระบบเข้าสู่ระบบ (Login)
        if (action === 'login') {
            const users = await sql`SELECT id, username, display_name, role FROM users WHERE username = ${payload.username} AND pin_code = ${payload.pin}`;
            if (users.length > 0) {
                return { statusCode: 200, body: JSON.stringify({ success: true, user: users[0] }) };
            }
            return { statusCode: 401, body: JSON.stringify({ success: false, message: 'ชื่อผู้ใช้หรือรหัสผ่าน(PIN) ไม่ถูกต้อง' }) };
        }

        // 2. ดึงรายชื่อพนักงานขาย
        if (action === 'get_staff') {
            const staff = await sql`SELECT display_name FROM users WHERE role IN ('Owner', 'Admin', 'Manager', 'Sales')`;
            return { statusCode: 200, body: JSON.stringify({ success: true, staff }) };
        }

        // 3. บันทึกข้อมูลออเดอร์
        if (action === 'save_order') {
            // แปลง Array ของ Items ให้เป็น JSON string เพื่อเก็บลงฟิลด์ JSONB
            const itemsJson = JSON.stringify(payload.items);
            
            const result = await sql`
                INSERT INTO orders (
                    customer_name, customer_phone, items, total_price, 
                    sale_staff, image_url, pdpa_consent, customer_age, customer_disease
                )
                VALUES (
                    ${payload.firstName + ' ' + payload.lastName}, 
                    ${payload.phone}, ${itemsJson}, ${payload.totalPrice}, 
                    ${payload.saleStaff}, ${payload.imageUrl}, ${payload.pdpa},
                    ${payload.age || null}, ${payload.disease || null}
                )
                RETURNING id`;
            return { statusCode: 200, body: JSON.stringify({ success: true, id: result[0].id }) };
        }

        // 4. อัปโหลดรูปลง Google Drive
        if (action === 'upload_image') {
            if (!process.env.GOOGLE_CREDENTIALS || !process.env.GDRIVE_FOLDER_ID) {
                throw new Error("ยังไม่ได้ตั้งค่า Google Drive Credentials ใน Netlify");
            }

            const auth = new google.auth.GoogleAuth({
                credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
                scopes: ['https://www.googleapis.com/auth/drive.file']
            });
            const drive = google.drive({ version: 'v3', auth });
            
            // แยก Base64
            const mimeTypeMatch = payload.base64.match(/data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+).*,/);
            const mimeType = mimeTypeMatch ? mimeTypeMatch[1] : 'image/jpeg';
            const base64Data = payload.base64.replace(/^data:image\/\w+;base64,/, '');
            const buffer = Buffer.from(base64Data, 'base64');
            
            const res = await drive.files.create({
                requestBody: { name: payload.fileName, parents: [process.env.GDRIVE_FOLDER_ID] },
                media: { mimeType: mimeType, body: require('stream').Readable.from(buffer) },
                fields: 'id, webViewLink'
            });
            return { statusCode: 200, body: JSON.stringify({ success: true, link: res.data.webViewLink }) };
        }

        return { statusCode: 400, body: JSON.stringify({ success: false, message: 'Invalid action' }) };

    } catch (err) {
        console.error("Backend Error:", err);
        return { statusCode: 500, body: JSON.stringify({ success: false, message: err.message }) };
    }
};