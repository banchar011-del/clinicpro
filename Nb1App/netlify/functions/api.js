const { neon } = require('@neondatabase/serverless');
const { google } = require('googleapis');

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ success: false, message: 'Method Not Allowed' }) };

    const dbUrl = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!dbUrl) return { statusCode: 500, body: JSON.stringify({ success: false, message: 'Database URL is missing' }) };
    const sql = neon(dbUrl);

    try {
        const body = JSON.parse(event.body);
        const { action, payload } = body;

        // ==========================================
        // 1. AUTH & STAFF (รวมการเปลี่ยนรูปโปรไฟล์ตัวเอง)
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
        if (action === 'update_own_avatar') {
            await sql`UPDATE users SET avatar_url = ${payload.avatar_url} WHERE id = ${payload.userId}`;
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // ==========================================
        // 2. CATALOG & TIERS
        // ==========================================
        if (action === 'get_catalog') {
            const categories = await sql`SELECT * FROM product_categories ORDER BY id ASC`;
            const products = await sql`SELECT * FROM products ORDER BY category_id, product_name ASC`;
            const tiers = await sql`SELECT * FROM commission_tiers ORDER BY min_sales ASC`;
            return { statusCode: 200, body: JSON.stringify({ success: true, categories, products, tiers }) };
        }
        
        if (action === 'manage_catalog') {
            if (payload.type === 'category') await sql`INSERT INTO product_categories (category_name, deduct_cost_percent) VALUES (${payload.name}, ${payload.percent})`;
            else if (payload.type === 'product') await sql`INSERT INTO products (category_id, product_name, unit_name) VALUES (${payload.categoryId}, ${payload.name}, ${payload.unit})`;
            else if (payload.type === 'tier') await sql`INSERT INTO commission_tiers (min_sales, max_sales, commission_percent) VALUES (${payload.min}, ${payload.max || null}, ${payload.percent})`;
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // ==========================================
        // 3. ORDERS & PAYMENTS
        // ==========================================
        if (action === 'save_order') {
            let customerId;
            const existing = await sql`SELECT id FROM customers WHERE phone = ${payload.phone}`;
            if (existing.length > 0) {
                customerId = existing[0].id;
                await sql`UPDATE customers SET 
                    first_name=${payload.firstName}, last_name=${payload.lastName}, emergency_phone=${payload.emergencyPhone||null},
                    line_id=${payload.lineId||null}, facebook=${payload.facebook||null},
                    age=${payload.age||null}, weight=${payload.weight||null}, height=${payload.height||null}, 
                    disease=${payload.disease||null}, drug_allergy=${payload.drugAllergy||null}, 
                    occupation=${payload.occupation||null}, workplace=${payload.workplace||null}, address=${payload.address||null},
                    pdpa_consent=${payload.pdpa} WHERE id=${customerId}`;
            } else {
                const newC = await sql`INSERT INTO customers 
                    (first_name, last_name, phone, emergency_phone, line_id, facebook, age, weight, height, disease, drug_allergy, occupation, workplace, address, pdpa_consent) 
                    VALUES (${payload.firstName}, ${payload.lastName}, ${payload.phone}, ${payload.emergencyPhone||null}, ${payload.lineId||null}, ${payload.facebook||null}, ${payload.age||null}, ${payload.weight||null}, ${payload.height||null}, ${payload.disease||null}, ${payload.drugAllergy||null}, ${payload.occupation||null}, ${payload.workplace||null}, ${payload.address||null}, ${payload.pdpa}) RETURNING id`;
                customerId = newC[0].id;
            }

            let targetOrderId = payload.existingOrderId;
            let isNewOrder = false;

            if (!targetOrderId && payload.items && payload.items.length > 0) {
                const itemsJson = JSON.stringify(payload.items); 
                const newOrder = await sql`INSERT INTO orders (customer_id, sale_staff_id, items, total_price, image_url, status) VALUES (${customerId}, ${payload.saleStaffId}, ${itemsJson}, ${payload.totalPrice}, ${payload.imageUrl}, 'Active') RETURNING id`;
                targetOrderId = newOrder[0].id;
                isNewOrder = true;
            }

            if (targetOrderId && payload.paymentAmount > 0) {
                const pType = payload.existingOrderId ? 'Old Debt' : 'New Order';
                await sql`INSERT INTO payments (order_id, amount, payment_method, receiver_id, image_url, payment_type) VALUES (${targetOrderId}, ${payload.paymentAmount}, ${payload.paymentMethod}, ${payload.currentUserId}, ${payload.imageUrl}, ${pType})`;
            }

            if (targetOrderId && payload.usageDetails) {
                await sql`INSERT INTO service_usage (order_id, customer_id, usage_date, details, dr_id, bt_id, created_by) VALUES (${targetOrderId}, ${customerId}, CURRENT_DATE, ${payload.usageDetails}, ${payload.drId||null}, ${payload.btId||null}, ${payload.currentUserId})`;
            }

            // Telegram Notification Logic (Based on Settings)
            try {
                const settings = await sql`SELECT * FROM system_settings LIMIT 1`;
                if (settings.length > 0 && settings[0].tg_token && settings[0].tg_config) {
                    const tgConfig = typeof settings[0].tg_config === 'string' ? JSON.parse(settings[0].tg_config) : settings[0].tg_config;
                    
                    if (isNewOrder && tgConfig.events.new_order) {
                        let txt = `🚨 <b>แจ้งทำรายการออเดอร์ใหม่</b>\n`;
                        if (tgConfig.fields.date) txt += `📅 วันที่: ${new Date().toLocaleDateString('th-TH')}\n`;
                        if (tgConfig.fields.name) txt += `👤 ลูกค้า: ${payload.firstName} ${payload.lastName}\n`;
                        if (tgConfig.fields.amount) txt += `💰 ชำระแล้ว: ${parseFloat(payload.paymentAmount).toLocaleString()} ฿\n`;
                        if (tgConfig.fields.staff) txt += `👩‍💼 พนักงาน: ${payload.saleStaffName}\n`;
                        
                        await fetch(`https://api.telegram.org/bot${settings[0].tg_token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: settings[0].tg_chat_id, text: txt, parse_mode: 'HTML' }) });
                    }
                    if (payload.usageDetails && !isNewOrder && tgConfig.events.usage) {
                        let txt = `💆‍♀️ <b>บันทึกการเข้าใช้บริการ</b>\n👤 ลูกค้า: ${payload.firstName}\n📝 ทำรายการ: ${payload.usageDetails}`;
                        await fetch(`https://api.telegram.org/bot${settings[0].tg_token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: settings[0].tg_chat_id, text: txt, parse_mode: 'HTML' }) });
                    }
                }
            } catch (e) { console.log('TG Error', e); }

            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // ==========================================
        // 4. SUMMARY & COMMISSION (กรองตามสิทธิ์)
        // ==========================================
        if (action === 'get_sales_summary') {
            const startDate = `${payload.startDate} 00:00:00`; 
            const endDate = `${payload.endDate} 23:59:59`;

            const settings = await sql`SELECT cc_fee_percent FROM system_settings LIMIT 1`;
            const ccFeePercent = settings.length > 0 ? parseFloat(settings[0].cc_fee_percent || 0) : 0;

            const orders = await sql`SELECT id, sale_staff_id, items, total_price FROM orders WHERE status != 'Cancelled' AND created_at >= ${startDate}::timestamp AND created_at <= ${endDate}::timestamp`;
            const payments = await sql`SELECT p.order_id, p.amount, p.payment_method FROM payments p JOIN orders o ON p.order_id = o.id WHERE p.created_at >= ${startDate}::timestamp AND p.created_at <= ${endDate}::timestamp`;
            const tiers = await sql`SELECT * FROM commission_tiers ORDER BY min_sales ASC`;
            const staffList = await sql`SELECT id, display_name FROM users`;

            let staffPerfMap = {};
            let shopTotalSales = 0; let shopTotalCollected = 0;

            orders.forEach(o => {
                const staffId = o.sale_staff_id;
                if (!staffPerfMap[staffId]) staffPerfMap[staffId] = { id: staffId, name: staffList.find(s=>s.id===staffId)?.display_name || 'ไม่ระบุ', total_sales: 0, total_collected: 0, total_cost: 0, order_count: 0 };
                
                let orderCost = 0;
                if (o.items && Array.isArray(o.items)) { o.items.forEach(item => { orderCost += ((parseFloat(item.total) || 0) * (parseFloat(item.deduct_percent) || 0) / 100); }); }
                
                staffPerfMap[staffId].total_sales += parseFloat(o.total_price);
                staffPerfMap[staffId].total_cost += orderCost;
                staffPerfMap[staffId].order_count += 1;
                shopTotalSales += parseFloat(o.total_price);
            });

            payments.forEach(p => {
                const order = orders.find(o => o.id === p.order_id);
                if (order) {
                    let amount = parseFloat(p.amount);
                    if (p.payment_method === 'บัตรเครดิต') amount = amount - (amount * (ccFeePercent / 100));
                    staffPerfMap[order.sale_staff_id].total_collected += amount;
                    shopTotalCollected += amount;
                }
            });

            let staffPerfArray = Object.values(staffPerfMap).map(sp => {
                let netCollected = sp.total_collected - sp.total_cost;
                if (netCollected < 0) netCollected = 0;
                let matchedTier = tiers[0] || { commission_percent: 0 };
                for (let i = 0; i < tiers.length; i++) { if (sp.total_sales >= parseFloat(tiers[i].min_sales) && (!tiers[i].max_sales || sp.total_sales <= parseFloat(tiers[i].max_sales))) matchedTier = tiers[i]; }
                return { ...sp, net_collected: netCollected, commission_percent: parseFloat(matchedTier.commission_percent), commission_amount: netCollected * (parseFloat(matchedTier.commission_percent) / 100) };
            });

            // Role Logic: ถ้าเป็นพนักงานปฏิบัติการ ให้ส่งกลับเฉพาะข้อมูลตัวเอง และซ่อน shopSummary
            if (['Sales', 'BT', 'Dr'].includes(payload.userRole)) {
                staffPerfArray = staffPerfArray.filter(sp => sp.id === payload.userId);
                shopTotalSales = 0; shopTotalCollected = 0; // ซ่อนยอดร้าน
            }

            staffPerfArray.sort((a, b) => b.total_sales - a.total_sales);
            return { statusCode: 200, body: JSON.stringify({ success: true, staffPerf: staffPerfArray, shopSummary: { totalSales: shopTotalSales, totalCollected: shopTotalCollected } }) };
        }

        // ==========================================
        // 5. APPOINTMENTS & CUSTOMERS (Role Based)
        // ==========================================
        if (action === 'get_appointments') {
            const appointments = await sql`SELECT a.id, a.appointment_date, a.appointment_time, a.service_details, a.status, c.first_name, c.last_name, c.phone, c.id as customer_id, u_dr.display_name as dr_name, u_bt.display_name as bt_name, a.dr_id, a.bt_id, a.created_by FROM appointments a JOIN customers c ON a.customer_id = c.id LEFT JOIN users u_dr ON a.dr_id = u_dr.id LEFT JOIN users u_bt ON a.bt_id = u_bt.id WHERE a.status != 'Cancelled' ORDER BY a.appointment_date ASC, a.appointment_time ASC LIMIT 100`;
            return { statusCode: 200, body: JSON.stringify({ success: true, appointments }) };
        }

        if (action === 'search_customers') {
            const q = payload.query || '';
            let customers = [];
            // ถ้าเป็นพนักงานระดับปฏิบัติการ จะค้นหาได้เฉพาะลูกค้าที่ตัวเองเกี่ยวข้อง
            if (['Sales', 'BT', 'Dr'].includes(payload.userRole)) {
                customers = await sql`
                    SELECT DISTINCT c.* FROM customers c
                    LEFT JOIN orders o ON c.id = o.customer_id
                    LEFT JOIN service_usage su ON c.id = su.customer_id
                    WHERE (c.first_name ILIKE ${'%'+q+'%'} OR c.last_name ILIKE ${'%'+q+'%'} OR c.phone ILIKE ${'%'+q+'%'})
                    AND (o.sale_staff_id = ${payload.userId} OR su.dr_id = ${payload.userId} OR su.bt_id = ${payload.userId})
                    ORDER BY c.first_name ASC LIMIT 50
                `;
            } else {
                customers = await sql`SELECT * FROM customers WHERE first_name ILIKE ${'%'+q+'%'} OR last_name ILIKE ${'%'+q+'%'} OR phone ILIKE ${'%'+q+'%'} ORDER BY first_name ASC LIMIT 50`;
            }
            return { statusCode: 200, body: JSON.stringify({ success: true, customers }) };
        }

        if (action === 'get_customer_full_detail') {
            const cid = payload.customerId;
            const profile = await sql`SELECT * FROM customers WHERE id = ${cid}`;
            const orders = await sql`SELECT o.id, o.created_at, o.total_price, o.status, o.items, o.sale_staff_id, u.display_name as sale_name FROM orders o LEFT JOIN users u ON o.sale_staff_id = u.id WHERE o.customer_id = ${cid} ORDER BY o.created_at DESC`;
            const payments = await sql`SELECT p.id, p.order_id, p.amount, p.created_at, p.payment_method, p.payment_type FROM payments p JOIN orders o ON p.order_id = o.id WHERE o.customer_id = ${cid} ORDER BY p.created_at DESC`;
            const usage = await sql`SELECT su.id, su.order_id, su.usage_date, su.details, dr.display_name as dr_name FROM service_usage su LEFT JOIN users dr ON su.dr_id = dr.id WHERE su.customer_id = ${cid} ORDER BY su.usage_date DESC`;
            const debt = await sql`SELECT (SELECT COALESCE(SUM(total_price), 0) FROM orders WHERE customer_id = ${cid} AND status != 'Cancelled') as total_price, (SELECT COALESCE(SUM(amount), 0) FROM payments p JOIN orders o ON p.order_id = o.id WHERE o.customer_id = ${cid}) as total_paid`;
            return { statusCode: 200, body: JSON.stringify({ success: true, customer: profile[0], orders, payments, usage, total_debt: debt[0].total_price - debt[0].total_paid }) };
        }

        // ==========================================
        // 6. UTILS & SETTINGS
        // ==========================================
        if (action === 'get_settings') {
            const settings = await sql`SELECT * FROM system_settings ORDER BY id DESC LIMIT 1`;
            return { statusCode: 200, body: JSON.stringify({ success: true, settings: settings[0] }) };
        }
        if (action === 'save_settings') {
            const tgJson = JSON.stringify(payload.tg_config);
            await sql`UPDATE system_settings SET 
                clinic_name=${payload.clinic_name}, ui_primary_color=${payload.ui_primary_color}, 
                ui_bg_color=${payload.ui_bg_color}, ui_nav_bg=${payload.ui_nav_bg}, ui_nav_text=${payload.ui_nav_text}, ui_board_text=${payload.ui_board_text},
                contact_info=${payload.contact_info}, logo_url=${payload.logo_url}, cc_fee_percent=${payload.cc_fee_percent},
                tg_token=${payload.tg_token}, tg_chat_id=${payload.tg_chat_id}, tg_config=${tgJson}::jsonb
            `;
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }
        
        if (action === 'manage_staff') {
            if (payload.subAction === 'delete') await sql`DELETE FROM users WHERE id = ${payload.id}`;
            else if (payload.subAction === 'add') await sql`INSERT INTO users (username, pin_code, display_name, role) VALUES (${payload.username}, ${payload.pin}, ${payload.name}, ${payload.role})`;
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        if (action === 'upload_image') {
            let credentials;
            if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) { credentials = { client_email: process.env.GOOGLE_CLIENT_EMAIL, private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') }; } 
            else if (process.env.GOOGLE_CREDENTIALS) { credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS); } 
            else throw new Error("Missing GDrive Config");
            const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive.file'] });
            const drive = google.drive({ version: 'v3', auth });
            const base64Data = payload.base64.replace(/^data:image\/\w+;base64,/, '');
            const buffer = Buffer.from(base64Data, 'base64');
            const res = await drive.files.create({ requestBody: { name: payload.fileName, parents: [process.env.GDRIVE_FOLDER_ID] }, media: { mimeType: 'image/jpeg', body: require('stream').Readable.from(buffer) }, fields: 'webViewLink' });
            return { statusCode: 200, body: JSON.stringify({ success: true, link: res.data.webViewLink }) };
        }

        return { statusCode: 400, body: JSON.stringify({ success: false, message: 'Invalid action' }) };
    } catch (err) {
        console.error(err); return { statusCode: 500, body: JSON.stringify({ success: false, message: err.message }) };
    }
};
