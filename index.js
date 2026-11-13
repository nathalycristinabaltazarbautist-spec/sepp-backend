const express = require('express');
const bodyParser = require('body-parser');
const pool = require('./db'); 
const admin = require('firebase-admin');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const bcrypt = require('bcrypt');

// Inicialización segura de Firebase (compatible con local y Render)
if (process.env.FIREBASE_PRIVATE_KEY) {
    // Si estamos en Render y usamos variables de entorno
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
        })
    });
} else {
    // Si estás en tu computadora local usando el archivo físico
    const serviceAccount = require('./serviceAccountKey.json');
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const app = express();
app.use(bodyParser.json());

const MY_IP = '192.168.1.52'; 
const PORT = process.env.PORT || 3000;

// Almacenamiento de fotografías de perfil
const carpetaPerfiles = path.join(__dirname, 'imagenes', 'perfiles');

// Crear carpeta si todavía no existe
fs.mkdirSync(carpetaPerfiles, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, carpetaPerfiles);
    },

    filename: (req, file, cb) => {
        const idDocente = req.params.id;
        const extension = path.extname(file.originalname).toLowerCase();

        const nombreUnico = `foto_${idDocente}_${Date.now()}${extension}`;

        cb(null, nombreUnico);
    }
});

const upload = multer({ storage: storage });

// Función centralizada para despachar notificaciones push en tiempo real mediante Firebase Cloud Messaging (FCM)
async function dispararAlertaPush(nombreSalon, tipoFalta) {
    if (!nombreSalon || !tipoFalta) return;
    
    const message = {
        notification: {
            title: '🚨 ALERTA: ' + nombreSalon,
            body: 'Se ha detectado: ' + tipoFalta
        },
        topic: 'alertas_seguridad',
        android: {
            priority: 'high',
            notification: { channelId: 'alertas_urgentes' }
        }
    };
    try {
        await admin.messaging().send(message);
        console.log(`[Firebase] Notificación enviada a ${nombreSalon}`);
    } catch (error) {
        console.error('[Firebase] Error:', error);
    }
}

// --- RUTAS DE LA API ---

// 1. Login exclusivo para Docentes
app.post('/api/login', async (req, res) => {
    const { correo, contrasena } = req.body;
    
    // VALIDACIÓN DEFENSIVA: Control de nulos y campos obligatorios vacíos.
    if (!correo || !contrasena) {
        return res.status(400).json({ success: false, message: "Por favor, complete correo y contraseña." });
    }

    try {
        const query = `
            SELECT d.id_docente, d.nombre, d.correo, d.contrasena, r.nombre_rol 
            FROM docentes d
            JOIN roles r ON d.id_rol = r.id_rol
            WHERE d.correo = $1 AND r.nombre_rol = 'docente'
        `;
        const result = await pool.query(query, [correo]);
        
        if (result.rows.length > 0) {
            const usuario = result.rows[0];

            // Comparamos la contraseña en texto plano con el hash de la base de datos de manera segura con bcrypt
            const passwordIsValid = await bcrypt.compare(contrasena, usuario.contrasena);

            if (passwordIsValid) {
                res.json({ 
                    success: true, 
                    id_docente: usuario.id_docente,
                    nombre: usuario.nombre,
                    correo: usuario.correo,
                    rol: usuario.nombre_rol 
                });
            } else {
                res.json({ success: false, message: "Contraseña incorrecta." });
            }
        } else {
            res.json({ success: false, message: "Correo no registrado o rol no autorizado." });
        }
    } catch (err) { 
        console.error("Error en login docente:", err);
        res.status(500).json({ success: false, message: err.message }); 
    }
});

// 2. Ruta exclusiva y segura para el Login de Administrador (Con Bcrypt)
app.post('/api/login-admin', async (req, res) => {
    const { correo, codigo_autorizacion, contrasena } = req.body;
    
    if (!correo || !codigo_autorizacion || !contrasena) {
        return res.status(400).json({ 
            success: false, 
            message: "Por favor, complete correo, código único y contraseña." 
        });
    }

    try {
        // Consultamos al administrador trayendo su contraseña hasheada
        const query = `
            SELECT d.id_docente, d.nombre, d.correo, d.contrasena, r.nombre_rol 
            FROM docentes d
            JOIN roles r ON d.id_rol = r.id_rol
            WHERE d.correo = $1 
              AND d.codigo_autorizacion = $2 
              AND r.nombre_rol = 'administrador'
        `;
        
        const result = await pool.query(query, [correo, codigo_autorizacion]);
        
        if (result.rows.length > 0) {
            const admin = result.rows[0];

            // Verificamos la contraseña con bcrypt.compare
            const passwordIsValid = await bcrypt.compare(contrasena, admin.contrasena);

            if (passwordIsValid) {
                res.json({ 
                    success: true, 
                    id_docente: admin.id_docente,
                    nombre: admin.nombre,
                    correo: admin.correo,
                    rol: admin.nombre_rol,
                    message: "Acceso maestro autorizado"
                });
            } else {
                res.json({ 
                    success: false, 
                    message: "Contraseña de Administrador incorrecta." 
                });
            }
        } else {
            res.json({ 
                success: false, 
                message: "Credenciales o Código de Autorización de Administrador incorrectos." 
            });
        }
    } catch (err) { 
        console.error("Error en login admin:", err);
        res.status(500).json({ success: false, message: err.message }); 
    }
});

// ==========================================
// MÓDULO DE ADMINISTRACIÓN (CRUD COMPLETO)
// ==========================================

// --- 1. GESTIÓN DE SALONES ---
app.get('/api/admin/salones', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM salones ORDER BY id_salon ASC');
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/admin/salones', async (req, res) => {
    const { nombre_salon } = req.body;
    if (!nombre_salon) {
        return res.status(400).json({ success: false, message: "El nombre del salón es obligatorio." });
    }
    try {
        await pool.query('INSERT INTO salones (nombre_salon) VALUES ($1)', [nombre_salon]);
        res.json({ success: true, message: 'Salón registrado correctamente' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.put('/api/admin/salones/:id', async (req, res) => {
    const { id } = req.params;
    const { nombre_salon } = req.body;
    if (!nombre_salon) {
        return res.status(400).json({ success: false, message: "El nombre del salón es obligatorio." });
    }
    try {
        await pool.query('UPDATE salones SET nombre_salon = $1 WHERE id_salon = $2', [nombre_salon, id]);
        res.json({ success: true, message: 'Salón actualizado' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.delete('/api/admin/salones/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM salones WHERE id_salon = $1', [id]);
        res.json({ success: true, message: 'Salón eliminado' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// --- 2. GESTIÓN DE CÁMARAS ---
app.get('/api/admin/camaras', async (req, res) => {
    try {
        const query = `
            SELECT c.*, s.nombre_salon 
            FROM camaras c 
            LEFT JOIN salones s ON c.id_salon = s.id_salon 
            ORDER BY c.codigo_camara ASC
        `;
        const result = await pool.query(query);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/admin/camaras', async (req, res) => {
    const { codigo_camara, id_salon, estado } = req.body;
    if (!codigo_camara || !id_salon || !estado) {
        return res.status(400).json({ success: false, message: "Todos los campos de la cámara son obligatorios." });
    }
    try {
        await pool.query('INSERT INTO camaras (codigo_camara, id_salon, estado) VALUES ($1, $2, $3)', [codigo_camara, id_salon, estado]);
        res.json({ success: true, message: 'Cámara registrada' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.put('/api/admin/camaras/:codigo', async (req, res) => {
    const { codigo } = req.params;
    const { id_salon, estado } = req.body;
    try {
        const query = 'UPDATE camaras SET id_salon = $1, estado = $2 WHERE codigo_camara = $3';
        await pool.query(query, [id_salon, estado, codigo]);
        res.json({ success: true, message: 'Cámara actualizada con éxito' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.delete('/api/admin/camaras/:codigo', async (req, res) => {
    const { codigo } = req.params;
    try {
        await pool.query('DELETE FROM camaras WHERE codigo_camara = $1', [codigo]);
        res.json({ success: true, message: 'Cámara eliminada' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});


// --- 3. GESTIÓN DE DOCENTES ---
app.get('/api/admin/docentes', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM docentes ORDER BY id_docente ASC');
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/admin/docentes', async (req, res) => {
    const { nombre, correo, contrasena, telefono, especialidad } = req.body;
    if (!nombre || !correo || !contrasena || !telefono || !especialidad) {
        return res.status(400).json({ success: false, message: "Todos los campos del docente son obligatorios." });
    }
    try {
        const rolRes = await pool.query("SELECT id_rol FROM roles WHERE nombre_rol = 'docente'");
        if (rolRes.rows.length === 0) {
            return res.status(400).json({ success: false, message: "El rol 'docente' no está configurado en la base de datos." });
        }
        const id_rol = rolRes.rows[0].id_rol;

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(contrasena, salt);

        await pool.query(
            'INSERT INTO docentes (id_rol, nombre, correo, contrasena, telefono, especialidad) VALUES ($1, $2, $3, $4, $5, $6)',
            [id_rol, nombre, correo, hashedPassword, telefono, especialidad]
        );

        res.json({ success: true, message: 'Docente registrado correctamente con rol docente y contraseña cifrada' });
    } catch (err) {
        console.error("Error al registrar docente:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.put('/api/admin/docentes/:id', async (req, res) => {
    const { id } = req.params;
    const { nombre, correo, telefono, especialidad } = req.body;
    try {
        await pool.query(
            'UPDATE docentes SET nombre = $1, correo = $2, telefono = $3, especialidad = $4 WHERE id_docente = $5',
            [nombre, correo, telefono, especialidad, id]
        );
        res.json({ success: true, message: 'Docente actualizado' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.delete('/api/admin/docentes/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM docentes WHERE id_docente = $1', [id]);
        res.json({ success: true, message: 'Docente eliminado' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});


// --- 4. ALERTAS GENERALES ---
app.get('/api/admin/alertas', async (req, res) => {
    try {
        const query = `
            SELECT 
                a.id_alerta,
                a.codigo_camara,
                COALESCE(s.nombre_salon, 'Área General') AS nombre_salon,
                COALESCE(d.nombre, 'Sin Docente Asignado') AS nombre_docente,
                a.tipo_falta,
                a.severidad,
                a.evidencia_url,
                TO_CHAR(a.fecha_hora, 'YYYY-MM-DD HH24:MI:SS') AS fecha_hora
            FROM alertas a
            LEFT JOIN camaras c ON a.codigo_camara = c.codigo_camara
            LEFT JOIN salones s ON c.id_salon = s.id_salon
            LEFT JOIN docentes d ON a.id_docente = d.id_docente
            ORDER BY a.fecha_hora DESC
        `;
        const result = await pool.query(query);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error("ERROR AL OBTENER ALERTAS:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});


// MÓDULO DE PERFIL Y SEGURIDAD (DOCENTE)

app.get('/api/perfil/:id', async (req, res) => {
    try {
        const query = 'SELECT nombre, especialidad, foto_url, telefono, codigo_autorizacion FROM docentes WHERE id_docente = $1';
        const result = await pool.query(query, [req.params.id]);
        
        if (result.rows.length > 0) {
            res.json(result.rows[0]);
        } else {
            res.status(404).json({ success: false, message: "Docente no encontrado" });
        }
    } catch (err) { 
        console.error("Error en BD:", err);
        res.status(500).json({ success: false, message: err.message }); 
    }
});

app.put('/api/perfil/telefono/:id', async (req, res) => {
    const { id } = req.params;
    const { telefono } = req.body;
    
    // Formato de teléfono exacto de 9 dígitos empezando en 9
    if (!telefono || !/^9\d{8}$/.test(telefono)) {
        return res.status(400).json({ success: false, message: "El teléfono debe tener 9 dígitos y empezar con 9." });
    }

    try {
        await pool.query('UPDATE docentes SET telefono = $1 WHERE id_docente = $2', [telefono, id]);
        res.json({ success: true, message: 'Teléfono actualizado con éxito' });
    } catch (err) {
        console.error("Error al actualizar teléfono:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.put('/api/perfil/password/:id', async (req, res) => {
    const { id } = req.params;
    const { passwordActual, passwordNueva } = req.body;

    if (!passwordActual || !passwordNueva || passwordNueva.length < 6) {
        return res.status(400).json({ success: false, message: 'La nueva contraseña debe tener al menos 6 caracteres.' });
    }

    try {
        const result = await pool.query('SELECT contrasena FROM docentes WHERE id_docente = $1', [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Docente no encontrado' });
        }

        const usuario = result.rows[0];

        const esCorrecta = await bcrypt.compare(passwordActual, usuario.contrasena);
        if (!esCorrecta) {
            return res.status(400).json({ success: false, message: 'La contraseña actual es incorrecta' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(passwordNueva, salt);

        await pool.query('UPDATE docentes SET contrasena = $1 WHERE id_docente = $2', [hashedPassword, id]);

        res.json({ success: true, message: 'Contraseña actualizada correctamente' });
    } catch (err) {
        console.error("Error al cambiar contraseña:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/subir-foto/:id', upload.single('foto'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "No se ha proporcionado ninguna imagen."
            });
        }
        const idDocente = req.params.id;
        const resOld = await pool.query(
            'SELECT foto_url FROM docentes WHERE id_docente = $1',
            [idDocente]
        );
        if (resOld.rows.length === 0) {
            fs.unlinkSync(req.file.path);

            return res.status(404).json({
                success: false,
                message: "Docente no encontrado."
            });
        }
        const fotoVieja = resOld.rows[0].foto_url;
        const nombreArchivo = req.file.filename;
        const actualizacion = await pool.query(
            'UPDATE docentes SET foto_url = $1 WHERE id_docente = $2 RETURNING foto_url',
            [nombreArchivo, idDocente]
        );
        // Eliminar fotografía anterior después de actualizar la BD
        if (fotoVieja && fotoVieja !== nombreArchivo) {
            const rutaAnterior = path.join(
                carpetaPerfiles,
                path.basename(fotoVieja)
            );

            if (fs.existsSync(rutaAnterior)) {
                fs.unlinkSync(rutaAnterior);
            }
        }
        console.log(
            `[PERFIL] Docente ${idDocente}: ${actualizacion.rows[0].foto_url}`
        );
        res.json({
            success: true,
            message: "Foto actualizada correctamente.",
            foto_url: actualizacion.rows[0].foto_url
        });

    } catch (err) {
        console.error("Error al subir foto:", err);

        res.status(500).json({
            success: false,
            message: "Error al actualizar la fotografía."
        });
    }
});

app.use('/imagenes', express.static(path.join(__dirname, 'imagenes')));

app.get('/api/alertas-historial', async (req, res) => {
    try {
        const query = `
            SELECT a.id_alerta, a.tipo_falta, a.fecha_hora, a.severidad, a.codigo_camara,
                   COALESCE(s.nombre_salon, 'Área General') as nombre_salon,
            CASE 
                WHEN a.evidencia_url IS NULL OR a.evidencia_url = '' THEN ''
                WHEN a.evidencia_url LIKE 'http%' THEN a.evidencia_url
                ELSE 'http://${MY_IP}:${PORT}/imagenes/' || a.evidencia_url 
            END as evidencia_url
            FROM alertas a
            LEFT JOIN camaras c ON a.codigo_camara = c.codigo_camara
            LEFT JOIN salones s ON c.id_salon = s.id_salon
            ORDER BY a.fecha_hora DESC;
        `;
        const result = await pool.query(query);
        res.json({ success: true, data: result.rows });
    } catch (err) { 
        console.error("Error en historial:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/alerta-actual/:id_docente', async (req, res) => {
    const idDocente = req.params.id_docente;
    try {
        const query = `
            SELECT 
                a.id_alerta, a.tipo_falta, a.fecha_hora, a.severidad, a.codigo_camara,
                COALESCE(s.nombre_salon, 'Área General') as nombre_salon,
                CASE 
                    WHEN a.evidencia_url IS NULL OR a.evidencia_url = '' THEN ''
                    WHEN a.evidencia_url LIKE 'http%' THEN a.evidencia_url
                    ELSE 'http://${MY_IP}:${PORT}/imagenes/' || a.evidencia_url 
                END as evidencia_url
            FROM alertas a
            LEFT JOIN camaras c ON a.codigo_camara = c.codigo_camara
            LEFT JOIN salones s ON c.id_salon = s.id_salon
            LEFT JOIN horarios_clases h ON s.id_salon = h.id_salon
            WHERE a.id_docente = $1 OR h.id_docente = $1 OR a.id_docente IS NULL
            ORDER BY a.fecha_hora DESC, a.id_alerta DESC 
            LIMIT 1;
        `;
        const result = await pool.query(query, [idDocente]);
        res.json({ success: true, data: result.rows[0] || {} });
    } catch (err) { 
        console.error("Error en alerta actual docente:", err);
        res.status(500).json({ success: false, message: err.message }); 
    }
});

app.get('/api/alertas/:id_salon', async (req, res) => {
    const { id_salon } = req.params;
    try {
        const query = `
            SELECT a.tipo_falta, a.fecha_hora, a.evidencia_url, a.severidad, 
                   COALESCE(s.nombre_salon, 'N/A') as nombre_salon, 
                   COALESCE(a.codigo_camara, 'Sin asignar') as codigo_camara
            FROM alertas a
            LEFT JOIN camaras c ON a.codigo_camara = c.codigo_camara
            LEFT JOIN salones s ON c.id_salon = s.id_salon
            WHERE (c.id_salon = $1 OR c.id_salon IS NULL) 
            ORDER BY a.fecha_hora DESC;
        `;
        const result = await pool.query(query, [id_salon]);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: "Error al obtener alertas" });
    }
});

app.get('/api/alertas-historial/:id_docente', async (req, res) => {
    const { id_docente } = req.params;
    try {
        const query = `
            SELECT DISTINCT ON (a.id_alerta) 
                a.id_alerta, a.tipo_falta, a.fecha_hora, a.severidad, a.codigo_camara,
                COALESCE(s.nombre_salon, 'Área General') as nombre_salon,
                CASE 
                    WHEN a.evidencia_url IS NULL OR a.evidencia_url = '' THEN ''
                    WHEN a.evidencia_url LIKE 'http%' THEN a.evidencia_url
                    ELSE 'http://${MY_IP}:${PORT}/imagenes/' || a.evidencia_url 
                END as evidencia_url
            FROM alertas a
            LEFT JOIN camaras c ON a.codigo_camara = c.codigo_camara
            LEFT JOIN salones s ON c.id_salon = s.id_salon
            LEFT JOIN horarios_clases h ON s.id_salon = h.id_salon
            WHERE a.id_docente = $1 OR h.id_docente = $1 OR a.id_docente IS NULL
            ORDER BY a.id_alerta, a.fecha_hora DESC;
        `;
        const result = await pool.query(query, [id_docente]);
        res.json({ success: true, data: result.rows });
    } catch (err) { 
        console.error("Error en historial docente:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/notificacion-flask', async (req, res) => {
    const { codigo_camara, tipo_falta, evidencia_url, severidad } = req.body;
    
    if (!codigo_camara || !tipo_falta) {
        return res.status(400).json({ success: false, message: "Datos incompletos desde el módulo de IA." });
    }

    try {
        await pool.query(
            'INSERT INTO alertas (codigo_camara, tipo_falta, evidencia_url, severidad, fecha_hora) VALUES ($1, $2, $3, $4, NOW())', 
            [codigo_camara, tipo_falta, evidencia_url, severidad]
        );
        const salonResult = await pool.query('SELECT nombre_salon FROM salones s JOIN camaras c ON s.id_salon = c.id_salon WHERE c.codigo_camara = $1', [codigo_camara]);
        const nombreSalon = salonResult.rows[0]?.nombre_salon || "Área Protegida";
        await dispararAlertaPush(nombreSalon, tipo_falta);
        res.json({ success: true, message: "Alerta procesada" });
    } catch (err) { 
        res.status(500).json({ success: false, message: err.message }); 
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor S.E.P.P. activo en puerto ${PORT}`);
});