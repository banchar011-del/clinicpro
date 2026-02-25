const { neon } = require('@neondatabase/serverless');
const { google } = require('googleapis');

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ success: false, message: 'Method Not Allowed' }) };
    }

    const dbUrl = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!dbUrl) return { statusCode: 500, body: JSON.stringify({ success: false, message: 'Database URL is missing' }) };

    const sql = neon(dbUrl);

    try {
        const body = JSON.parse(event.body);
        const { action, payload } = body;

        // ==========================================
        // 1. AUTHENTICATION & STAFF
        // ==========================================
        if (action === 'login') {
            const users = await sql`SELECT id, username, display_name, role, avatar_url FROM users WHERE username = ${payload.username} AND pin_code = ${payload.pin}`;
            if (users.length > 0) return { statusCode: 200, body: JSON.stringify({ success: true, user: users[0] }) };
            return { statusCode: 401, body: JSON.stringify({ success: false, message: 'ข้อมูลไม่ถูกต้อง' }) };
        }

        if (action === 'get_staff') {
            const staff = await sql`SELECT id, username, display_name, role, avatar_url FROM users ORDER BY role, display_name`;
            return { statusCode: 200, body: JSON.stringify({ success: true, staff }) };
        }

        // ==========================================
        // 2. ORDERS, PAYMENTS & USAGE
        // ==========================================
        if (action === 'save_order') {
            // 2.1 Customer Upsert
            let customerId;
            const existing = await sql`SELECT id FROM customers WHERE phone = ${payload.phone}`;
            if (existing.length > 0) {
                customerId = existing[0].id;
                await sql`UPDATE customers SET first_name=${payload.firstName}, last_name=${payload.lastName}, age=${payload.age||null}, disease=${payload.disease||null}, pdpa_consent=${payload.pdpa} WHERE id=${customerId}`;
            } else {
                const newC = await sql`INSERT INTO customers (first_name, last_name, phone, age, disease, pdpa_consent) VALUES (${payload.firstName}, ${payload.lastName}, ${payload.phone}, ${payload.age||null}, ${payload.disease||null}, ${payload.pdpa}) RETURNING id`;
                customerId = newC[0].id;
            }

            let targetOrderId = payload.existingOrderId; // ถ้ามีการเลือกจ่ายบิลเก่า

            // 2.2 Create Order (ถ้าเป็นการเปิดบิลใหม่)
            if (!targetOrderId && payload.items && payload.items.length > 0) {
                const itemsJson = JSON.stringify(payload.items);
                const newOrder = await sql`INSERT INTO orders (customer_id, sale_staff_id, items, total_price, image_url, status) VALUES (${customerId}, ${payload.saleStaffId}, ${itemsJson}, ${payload.totalPrice}, ${payload.imageUrl}, 'Active') RETURNING id`;
                targetOrderId = newOrder[0].id;
            }

            // 2.3 Create Payment (บันทึกยอดชำระ)
            if (targetOrderId && payload.paymentAmount > 0) {
                const pType = payload.existingOrderId ? 'Old Debt' : 'New Order';
                await sql`INSERT INTO payments (order_id, amount, payment_method, receiver_id, image_url, payment_type) VALUES (${targetOrderId}, ${payload.paymentAmount}, ${payload.paymentMethod || 'Transfer'}, ${payload.currentUserId}, ${payload.imageUrl}, ${pType})`;
            }

            // 2.4 Create Service Usage (บันทึกการเข้าทำ / ตัดคอร์ส)
            if (targetOrderId && payload.usageDetails) {
                await sql`INSERT INTO service_usage (order_id, customer_id, usage_date, details, dr_id, bt_id, created_by) VALUES (${targetOrderId}, ${customerId}, CURRENT_DATE, ${payload.usageDetails}, ${payload.drId||null}, ${payload.btId||null}, ${payload.currentUserId})`;
            }

            // 2.5 Telegram Alert
            try {
                const settings = await sql`SELECT * FROM system_settings LIMIT 1`;
                if (settings.length > 0 && settings[0].tg_token && settings[0].alert_new_order) {
                    let txt = `🚨 <b>แจ้งเตือนการทำรายการ</b>\n👤 ${payload.firstName} ${payload.lastName}\n💰 ยอดชำระ: ${parseFloat(payload.paymentAmount).toLocaleString()} ฿\n👩‍💼 พนักงาน: ${payload.saleStaffName}`;
                    await fetch(`https://api.telegram.org/bot${settings[0].tg_token}/sendMessage`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: settings[0].tg_chat_id, text: txt, parse_mode: 'HTML' })
                    });
                }
            } catch (e) {}

            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // ==========================================
        // 3. APPOINTMENTS
        // ==========================================
        if (action === 'get_appointments') {
            const appointments = await sql`
                SELECT a.id, a.appointment_date, a.appointment_time, a.service_details, a.status, c.first_name, c.last_name, c.phone, c.id as customer_id, u_dr.display_name as dr_name, u_bt.display_name as bt_name
                FROM appointments a JOIN customers c ON a.customer_id = c.id
                LEFT JOIN users u_dr ON a.dr_id = u_dr.id LEFT JOIN users u_bt ON a.bt_id = u_bt.id
                WHERE a.status != 'Cancelled' ORDER BY a.appointment_date ASC, a.appointment_time ASC LIMIT 100
            `;
            return { statusCode: 200, body: JSON.stringify({ success: true, appointments }) };
        }

        if (action === 'save_appointment') {
            // โลจิกเหมือนเดิม (ตัดทอนเพื่อประหยัดบรรทัด)
            let customerId; const existing = await sql`SELECT id FROM customers WHERE phone = ${payload.phone}`;
            if (existing.length > 0) customerId = existing[0].id;
            else { const newC = await sql`INSERT INTO customers (first_name, last_name, phone) VALUES (${payload.firstName}, ${payload.lastName}, ${payload.phone}) RETURNING id`; customerId = newC[0].id; }
            await sql`INSERT INTO appointments (customer_id, appointment_date, appointment_time, service_details, dr_id, bt_id, created_by) VALUES (${customerId}, ${payload.date}, ${payload.time}, ${payload.details}, ${payload.drId||null}, ${payload.btId||null}, ${payload.currentUserId})`;
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }
        if (action === 'update_appointment') {
            if (payload.status === 'Cancelled') await sql`UPDATE appointments SET status='Cancelled' WHERE id=${payload.id}`;
            else await sql`UPDATE appointments SET appointment_date=${payload.newDate}, appointment_time=${payload.newTime} WHERE id=${payload.id}`;
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // ==========================================
        // 4. CUSTOMERS & SUMMARY
        // ==========================================
        if (action === 'search_customers') {
            const q = payload.query || '';
            const customers = await sql`SELECT id, first_name, last_name, phone, age, disease FROM customers WHERE first_name ILIKE ${'%'+q+'%'} OR phone ILIKE ${'%'+q+'%'} ORDER BY first_name ASC LIMIT 50`;
            return { statusCode: 200, body: JSON.stringify({ success: true, customers }) };
        }

        if (action === 'get_customer_full_detail') {
            const cid = payload.customerId;
            const profile = await sql`SELECT * FROM customers WHERE id = ${cid}`;
            const orders = await sql`SELECT o.id, o.created_at, o.total_price, o.status, o.items, u.display_name as sale_name FROM orders o LEFT JOIN users u ON o.sale_staff_id = u.id WHERE o.customer_id = ${cid} ORDER BY o.created_at DESC`;
            const payments = await sql`SELECT p.id, p.order_id, p.amount, p.created_at, p.payment_method, p.payment_type FROM payments p JOIN orders o ON p.order_id = o.id WHERE o.customer_id = ${cid} ORDER BY p.created_at DESC`;
            const usage = await sql`SELECT su.id, su.order_id, su.usage_date, su.details, dr.display_name as dr_name FROM service_usage su LEFT JOIN users dr ON su.dr_id = dr.id WHERE su.customer_id = ${cid} ORDER BY su.usage_date DESC`;
            return { statusCode: 200, body: JSON.stringify({ success: true, customer: profile[0], orders, payments, usage }) };
        }

        if (action === 'get_sales_summary') {
            const startDate = `${payload.month}-01`; const endDate = `${payload.month}-31 23:59:59`;
            const dailySales = await sql`SELECT DATE(created_at) as date, SUM(total_price) as total FROM orders WHERE status != 'Cancelled' AND created_at >= ${startDate}::timestamp AND created_at <= ${endDate}::timestamp GROUP BY DATE(created_at) ORDER BY date ASC`;
            const staffPerf = await sql`SELECT u.display_name, COUNT(o.id) as order_count, SUM(o.total_price) as total_sales FROM orders o JOIN users u ON o.sale_staff_id = u.id WHERE o.status != 'Cancelled' AND o.created_at >= ${startDate}::timestamp AND o.created_at <= ${endDate}::timestamp GROUP BY u.display_name ORDER BY total_sales DESC`;
            return { statusCode: 200, body: JSON.stringify({ success: true, dailySales, staffPerf }) };
        }

        // ==========================================
        // 5. SETTINGS & UTILS (รวม UI Customization)
        // ==========================================
        if (action === 'get_settings') {
            const settings = await sql`SELECT * FROM system_settings ORDER BY id DESC LIMIT 1`;
            return { statusCode: 200, body: JSON.stringify({ success: true, settings: settings[0] }) };
        }

        if (action === 'save_settings') {
            // รวมทั้ง TG และ UI
            await sql`
                UPDATE system_settings 
                SET tg_token=${payload.tg_token}, tg_chat_id=${payload.tg_chat_id}, alert_new_order=${payload.alert_new_order},
                    clinic_name=${payload.clinic_name}, ui_primary_color=${payload.ui_primary_color}, 
                    ui_bg_color=${payload.ui_bg_color}, contact_info=${payload.contact_info}, logo_url=${payload.logo_url}
            `;
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        if (action === 'manage_staff') {
            if (payload.subAction === 'add') {
                await sql`INSERT INTO users (username, pin_code, display_name, role, avatar_url) VALUES (${payload.username}, ${payload.pin}, ${payload.name}, ${payload.role}, ${payload.avatar_url||null})`;
            } else if (payload.subAction === 'update_avatar') {
                await sql`UPDATE users SET avatar_url = ${payload.avatar_url} WHERE id = ${payload.id}`;
            } else if (payload.subAction === 'delete') {
                await sql`DELETE FROM users WHERE id = ${payload.id}`;
            }
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        if (action === 'upload_image') {
            let credentials;
            if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
                credentials = { client_email: process.env.GOOGLE_CLIENT_EMAIL, private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') };
            } else if (process.env.GOOGLE_CREDENTIALS) {
                credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
            } else throw new Error("Missing GDrive Config");

            const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive.file'] });
            const drive = google.drive({ version: 'v3', auth });
            const base64Data = payload.base64.replace(/^data:image\/\w+;base64,/, '');
            const buffer = Buffer.from(base64Data, 'base64');
            const res = await drive.files.create({
                requestBody: { name: payload.fileName, parents: [process.env.GDRIVE_FOLDER_ID] },
                media: { mimeType: 'image/jpeg', body: require('stream').Readable.from(buffer) },
                fields: 'webViewLink'
            });
            return { statusCode: 200, body: JSON.stringify({ success: true, link: res.data.webViewLink }) };
        }

        return { statusCode: 400, body: JSON.stringify({ success: false, message: 'Invalid action' }) };
    } catch (err) {
        console.error(err);
        return { statusCode: 500, body: JSON.stringify({ success: false, message: err.message }) };
    }
};
