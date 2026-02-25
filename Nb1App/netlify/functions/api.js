const { neon } = require('@neondatabase/serverless');
const { google } = require('googleapis');

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ success: false, message: 'Method Not Allowed' }) };
    }

    const dbUrl = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!dbUrl) {
        return { statusCode: 500, body: JSON.stringify({ success: false, message: 'Database URL is missing' }) };
    }

    const sql = neon(dbUrl);

    try {
        const body = JSON.parse(event.body);
        const { action, payload } = body;

        // ==========================================
        // 🔐 1. AUTHENTICATION & STAFF
        // ==========================================
        if (action === 'login') {
            const users = await sql`SELECT id, username, display_name, role FROM users WHERE username = ${payload.username} AND pin_code = ${payload.pin}`;
            if (users.length > 0) {
                return { statusCode: 200, body: JSON.stringify({ success: true, user: users[0] }) };
            }
            return { statusCode: 401, body: JSON.stringify({ success: false, message: 'ชื่อผู้ใช้หรือรหัสผ่าน(PIN) ไม่ถูกต้อง' }) };
        }

        if (action === 'get_staff') {
            const staff = await sql`SELECT id, display_name, role FROM users WHERE role IN ('Owner', 'Admin', 'Manager', 'Sales', 'BT', 'Dr') ORDER BY role, display_name`;
            return { statusCode: 200, body: JSON.stringify({ success: true, staff }) };
        }

        // ==========================================
        // 📝 2. ORDERS & PAYMENTS (บันทึกข้อมูล)
        // ==========================================
        if (action === 'save_order') {
            // 2.1 Upsert Customer
            let customerId;
            const existingCustomer = await sql`SELECT id FROM customers WHERE phone = ${payload.phone}`;
            if (existingCustomer.length > 0) {
                customerId = existingCustomer[0].id;
                await sql`UPDATE customers SET first_name=${payload.firstName}, last_name=${payload.lastName}, age=${payload.age||null}, disease=${payload.disease||null}, pdpa_consent=${payload.pdpa} WHERE id=${customerId}`;
            } else {
                const newC = await sql`INSERT INTO customers (first_name, last_name, phone, age, disease, pdpa_consent) VALUES (${payload.firstName}, ${payload.lastName}, ${payload.phone}, ${payload.age||null}, ${payload.disease||null}, ${payload.pdpa}) RETURNING id`;
                customerId = newC[0].id;
            }

            // 2.2 Create Order
            const itemsJson = JSON.stringify(payload.items);
            const newOrder = await sql`INSERT INTO orders (customer_id, sale_staff_id, items, total_price, image_url, status) VALUES (${customerId}, ${payload.saleStaffId}, ${itemsJson}, ${payload.totalPrice}, ${payload.imageUrl}, 'Active') RETURNING id`;
            const orderId = newOrder[0].id;

            // 2.3 Create Payment (Initial)
            if (payload.totalPrice > 0) {
                await sql`INSERT INTO payments (order_id, amount, payment_method, receiver_id, image_url) VALUES (${orderId}, ${payload.totalPrice}, 'Transfer/Cash', ${payload.currentUserId}, ${payload.imageUrl})`;
            }

            // 2.4 Telegram Alert
            try {
                const settings = await sql`SELECT * FROM system_settings LIMIT 1`;
                const set = settings[0];
                if (set && set.tg_token && set.tg_chat_id && set.alert_new_order) {
                    let itemListTxt = payload.items.map(i => `- ${i.name} (${i.price.toLocaleString()}฿)`).join('\n');
                    const msg = `🚨 <b>New Order!</b>\n👤 ${payload.firstName} ${payload.lastName}\n🛍️\n${itemListTxt}\n💰 ${payload.totalPrice.toLocaleString()} THB\n👩‍💼 ${payload.saleStaffName}`;
                    await fetch(`https://api.telegram.org/bot${set.tg_token}/sendMessage`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chat_id: set.tg_chat_id, text: msg, parse_mode: 'HTML' })
                    });
                }
            } catch (e) {}

            return { statusCode: 200, body: JSON.stringify({ success: true, orderId }) };
        }

        // ==========================================
        // 📅 3. APPOINTMENTS (นัดหมาย)
        // ==========================================
        if (action === 'get_appointments') {
            const appointments = await sql`
                SELECT a.id, a.appointment_date, a.appointment_time, a.service_details, a.status,
                       c.first_name, c.last_name, c.phone, c.id as customer_id,
                       u_dr.display_name as dr_name, u_bt.display_name as bt_name
                FROM appointments a
                JOIN customers c ON a.customer_id = c.id
                LEFT JOIN users u_dr ON a.dr_id = u_dr.id
                LEFT JOIN users u_bt ON a.bt_id = u_bt.id
                WHERE a.status != 'Cancelled'
                ORDER BY a.appointment_date ASC, a.appointment_time ASC LIMIT 50
            `;
            return { statusCode: 200, body: JSON.stringify({ success: true, appointments }) };
        }

        if (action === 'save_appointment') {
            let customerId;
            const existing = await sql`SELECT id FROM customers WHERE phone = ${payload.phone}`;
            if (existing.length > 0) customerId = existing[0].id;
            else {
                const newC = await sql`INSERT INTO customers (first_name, last_name, phone) VALUES (${payload.firstName}, ${payload.lastName}, ${payload.phone}) RETURNING id`;
                customerId = newC[0].id;
            }
            await sql`INSERT INTO appointments (customer_id, appointment_date, appointment_time, service_details, dr_id, bt_id, created_by) VALUES (${customerId}, ${payload.date}, ${payload.time}, ${payload.details}, ${payload.drId||null}, ${payload.btId||null}, ${payload.currentUserId})`;
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        if (action === 'update_appointment') {
            if (payload.status === 'Cancelled') await sql`UPDATE appointments SET status='Cancelled' WHERE id=${payload.id}`;
            else await sql`UPDATE appointments SET appointment_date=${payload.newDate}, appointment_time=${payload.newTime} WHERE id=${payload.id}`;
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // ==========================================
        // 👥 4. CUSTOMERS (หน้าลูกค้า - ใหม่)
        // ==========================================
        if (action === 'search_customers') {
            const q = payload.query || '';
            const customers = await sql`
                SELECT id, first_name, last_name, phone, age, disease
                FROM customers
                WHERE first_name ILIKE ${'%' + q + '%'} OR last_name ILIKE ${'%' + q + '%'} OR phone ILIKE ${'%' + q + '%'}
                ORDER BY first_name ASC LIMIT 50
            `;
            return { statusCode: 200, body: JSON.stringify({ success: true, customers }) };
        }

        if (action === 'get_customer_full_detail') {
            const cid = payload.customerId;
            
            // 1. Profile
            const profile = await sql`SELECT * FROM customers WHERE id = ${cid}`;
            
            // 2. Orders & Sales Info
            const orders = await sql`
                SELECT o.id, o.created_at, o.total_price, o.status, o.items, u.display_name as sale_name
                FROM orders o
                LEFT JOIN users u ON o.sale_staff_id = u.id
                WHERE o.customer_id = ${cid} ORDER BY o.created_at DESC
            `;

            // 3. Payments
            const payments = await sql`
                SELECT p.id, p.order_id, p.amount, p.created_at, p.payment_method
                FROM payments p
                JOIN orders o ON p.order_id = o.id
                WHERE o.customer_id = ${cid} ORDER BY p.created_at DESC
            `;

            // 4. Service Usage (History)
            const usage = await sql`
                SELECT su.id, su.order_id, su.usage_date, su.details, dr.display_name as dr_name
                FROM service_usage su
                LEFT JOIN users dr ON su.dr_id = dr.id
                WHERE su.customer_id = ${cid} ORDER BY su.usage_date DESC
            `;

            // 5. Debt Calculation
            const debt = await sql`
                 SELECT 
                    (SELECT COALESCE(SUM(total_price), 0) FROM orders WHERE customer_id = ${cid} AND status != 'Cancelled') as total_price,
                    (SELECT COALESCE(SUM(amount), 0) FROM payments p JOIN orders o ON p.order_id = o.id WHERE o.customer_id = ${cid}) as total_paid
            `;

            return { statusCode: 200, body: JSON.stringify({ 
                success: true, 
                customer: profile[0],
                orders,
                payments,
                usage,
                total_debt: debt[0].total_price - debt[0].total_paid
            }) };
        }

        // ==========================================
        // 📊 5. SUMMARY (หน้าสรุปยอด - ใหม่)
        // ==========================================
        if (action === 'get_sales_summary') {
            const month = payload.month; // 'YYYY-MM'
            const startDate = `${month}-01`;
            const endDate = `${month}-31 23:59:59`; // Approximate

            // Daily Sales
            const dailySales = await sql`
                SELECT DATE(created_at) as date, SUM(total_price) as total
                FROM orders
                WHERE status != 'Cancelled' AND created_at >= ${startDate}::timestamp AND created_at <= ${endDate}::timestamp
                GROUP BY DATE(created_at) ORDER BY date ASC
            `;

            // Staff Performance
            const staffPerf = await sql`
                SELECT u.display_name, COUNT(o.id) as order_count, SUM(o.total_price) as total_sales
                FROM orders o
                JOIN users u ON o.sale_staff_id = u.id
                WHERE o.status != 'Cancelled' AND o.created_at >= ${startDate}::timestamp AND o.created_at <= ${endDate}::timestamp
                GROUP BY u.display_name ORDER BY total_sales DESC
            `;
            
            return { statusCode: 200, body: JSON.stringify({ success: true, dailySales, staffPerf }) };
        }

        // ==========================================
        // ⚙️ 6. SETTINGS & STAFF MANAGEMENT (ใหม่)
        // ==========================================
        if (action === 'get_all_users') {
            const users = await sql`SELECT id, username, display_name, role FROM users ORDER BY id ASC`;
            return { statusCode: 200, body: JSON.stringify({ success: true, users }) };
        }
        
        if (action === 'manage_staff') {
            if (payload.subAction === 'add') {
                await sql`INSERT INTO users (username, pin_code, display_name, role) VALUES (${payload.username}, ${payload.pin}, ${payload.name}, ${payload.role})`;
            } else if (payload.subAction === 'reset_pin') {
                await sql`UPDATE users SET pin_code = ${payload.pin} WHERE id = ${payload.id}`;
            } else if (payload.subAction === 'delete') {
                await sql`DELETE FROM users WHERE id = ${payload.id}`;
            }
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }
        
        if (action === 'get_settings') {
            const settings = await sql`SELECT * FROM system_settings ORDER BY id DESC LIMIT 1`;
            return { statusCode: 200, body: JSON.stringify({ success: true, settings: settings[0] }) };
        }
        if (action === 'save_settings') {
            await sql`UPDATE system_settings SET tg_token=${payload.tg_token}, tg_chat_id=${payload.tg_chat_id}, alert_new_order=${payload.alert_new_order}`;
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // ==========================================
        // ☁️ 7. UTILS
        // ==========================================
        if (action === 'upload_image') {
            if (!process.env.GOOGLE_CREDENTIALS) throw new Error("Missing GDrive Config");
            const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS), scopes: ['https://www.googleapis.com/auth/drive.file'] });
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