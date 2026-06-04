const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'SPC API Documentation',
      version: '1.0.1',
      description: 'SPC IoT 시스템 데이터 조회/제어 API (PostgreSQL 기반)',
    },
    servers: [
      { url: 'http://localhost:3000', description: 'Development Server' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
  },
  apis: ['./server.js'],
};

module.exports = swaggerJsdoc(options);
