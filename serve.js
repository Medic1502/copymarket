const express = require('express');
const path = require('path');
const app = express();

app.use(express.static(path.join(__dirname, 'FrontEnd')));

app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'FrontEnd', 'app.html'));
});

app.listen(8080, () => console.log('Frontend na http://localhost:8080'));