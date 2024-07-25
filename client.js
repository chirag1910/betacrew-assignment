const { Socket } = require("net");
const fs = require("fs");
const path = require("path");

class PacketHandler {
	constructor() {
		this.receivedPackets = [];
		this.receivedSeq = new Set();
	}

	addNewPacket(packet) {
		try {
			const parsedData = DataHandler.decodeResponse(packet);

			this.receivedPackets.push(parsedData);
			this.receivedSeq.add(parsedData.packetSeq);
		} catch (err) {
			throw new Error("Invalid packet received.");
		}
	}

	getHighestPacketSeq() {
		return Math.max(...Array.from(this.receivedSeq));
	}

	getMissingPacketSequences() {
		const highestPacketSeq = this.getHighestPacketSeq();

		const missingPacketSequences = [];

		for (let i = 1; i < highestPacketSeq; i++) {
			if (!this.receivedSeq.has(i)) {
				missingPacketSequences.push(i);
			}
		}

		return missingPacketSequences;
	}

	getSortedPackets() {
		return this.receivedPackets.sort((a, b) => a.packetSeq - b.packetSeq);
	}

	toSortedPacketsJSON() {
		return JSON.stringify(this.getSortedPackets());
	}

	dumpJSON(filepath) {
		const dirPath = path.dirname(filepath);

		if (!fs.existsSync(dirPath)) {
			fs.mkdirSync(dirPath, { recursive: true });
		}

		fs.writeFileSync(filepath, this.toSortedPacketsJSON());
	}
}

class DataHandler {
	static decodeResponse(data) {
		try {
			const buffer = Buffer.from(data);
			const parsedData = this.validateResponse(buffer);
			return parsedData;
		} catch (err) {
			throw new Error("Invalid data recieved.");
		}
	}

	static encodeRequest(callType, resendSeq) {
		const buffer = Buffer.alloc(2);

		buffer.writeUInt8(callType, 0);
		buffer.writeUInt8(resendSeq, 1);

		return buffer;
	}

	static validateResponse(buffer) {
		const buySell = String.fromCharCode(buffer.readUIntBE(4, 1));
		if (buySell !== "B" && buySell !== "S") {
			throw new Error("Invalid Buy/Sell Indicator.");
		}

		const quantity = buffer.readInt32BE(5, 4);
		if (!Number.isInteger(quantity) || quantity < 0) {
			throw new Error("Invalid quantity.");
		}

		const price = buffer.readInt32BE(9, 4);
		if (!Number.isInteger(price) || price < 0) {
			throw new Error("Invalid price.");
		}

		const packetSeq = buffer.readInt32BE(13, 4);
		if (!Number.isInteger(packetSeq) || packetSeq < 0) {
			throw new Error("Invalid packet sequence.");
		}

		return {
			symbol: String.fromCharCode(buffer.readUIntBE(0, 4)),
			buySell,
			quantity,
			price,
			packetSeq,
		};
	}
}

class Client {
	constructor() {
		this.client = new Socket();
	}

	run(port, request, onResponseReceive) {
		return new Promise((resolve, reject) => {
			this.client.connect(port, () => {
				const onData = (data) => {
					try {
						onResponseReceive(data);
					} catch (err) {
						this.client.end();
						reject(err);
					}
				};

				const onClose = () => {
					this.client.removeListener("data", onData);
					this.client.removeListener("error", onError);
					resolve();
				};

				const onError = (err) => {
					this.client.removeListener("data", onData);
					this.client.removeListener("close", onClose);
					reject(err);
				};

				this.client.on("data", onData);

				this.client.on("close", onClose);
				this.client.on("error", onError);

				this.client.write(request);
			});

			this.client.on("error", (err) => {
				reject("Unable to connect to server");
			});
		});
	}

	close() {
		this.client.end();
	}
}

const FILE_PATH = path.join(__dirname, "output.json");
const PORT = 3000;

(async () => {
	const packetHandler = new PacketHandler();
	const client = new Client();

	const streamAllPacketRequest = DataHandler.encodeRequest(1, 0);
	try {
		await client.run(PORT, streamAllPacketRequest, (data) => {
			try {
				packetHandler.addNewPacket(data);
			} catch (err) {
				throw new Error("Error occurred while processing packet.");
			}
		});

		const missingPacketSequences =
			packetHandler.getMissingPacketSequences();

		for (const seq of missingPacketSequences) {
			const streamMissingPacketRequest = DataHandler.encodeRequest(
				2,
				seq
			);

			await client.run(PORT, streamMissingPacketRequest, (data) => {
				try {
					packetHandler.addNewPacket(data);
					client.close();
				} catch (err) {
					throw new Error("Error occurred while processing packet.");
				}
			});
		}

		packetHandler.dumpJSON(FILE_PATH);
		client.close();
	} catch (err) {
		client.close();
		console.log(err);
	}
})();
