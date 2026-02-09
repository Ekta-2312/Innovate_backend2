const clients = [];

const addClient = (req, res) => {
    const headers = {
        'Content-Type': 'text/event-stream',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache'
    };
    res.writeHead(200, headers);

    const clientId = Date.now();
    const newClient = {
        id: clientId,
        res
    };
    clients.push(newClient);

    req.on('close', () => {
        const index = clients.findIndex(c => c.id === clientId);
        if (index !== -1) {
            clients.splice(index, 1);
        }
    });
};

const broadcastNotification = (data) => {
    clients.forEach(client => client.res.write(`data: ${JSON.stringify(data)}\n\n`));
};

module.exports = { addClient, broadcastNotification };
