const { Pool } = require('pg');

// Configuración del Pool de Conexiones para PostgreSQL utilizando Neon DB con protocolo seguro SSL.
const pool = new Pool({
  // Cadena de conexión estricta hacia la base de datos en la nube. En producción se recomienda usar process.env.DATABASE_URL
connectionString: process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_vfwcGn4t7yhP@ep-noisy-cell-axuikm8s-pooler.c-4.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require',  ssl: {
    rejectUnauthorized: false
  }
});

// Captura y maneja errores inesperados en clientes inactivos del pool para prevenir caídas del servidor.
pool.on('error', (err, client) => {
  console.error('⚠️ Error inesperado en el cliente de base de datos inactivo:', err);
});

module.exports = pool;