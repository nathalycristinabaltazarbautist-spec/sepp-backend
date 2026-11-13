const { Pool } = require('pg');

// Configuración del Pool de Conexiones para PostgreSQL utilizando Neon DB con protocolo seguro SSL.
const pool = new Pool({
  // Cadena de conexión estricta hacia la base de datos en la nube. En producción se recomienda usar process.env.DATABASE_URL
connectionString: process.env.DATABASE_URL,  ssl: {
    rejectUnauthorized: false
  }
});

// Captura y maneja errores inesperados en clientes inactivos del pool para prevenir caídas del servidor.
pool.on('error', (err, client) => {
  console.error('⚠️ Error inesperado en el cliente de base de datos inactivo:', err);
});

module.exports = pool;