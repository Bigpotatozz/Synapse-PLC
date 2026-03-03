const axios = require("axios");
const net = require("net");

class Client {
  constructor(ip, puerto, dmInicial, cantidad) {
    this.ip = ip;
    this.puerto = puerto;
    this.dmInicial = dmInicial;
    this.cantidad = cantidad;

    this.client = null;
    this.isConnected = false;
    this.buffer = "";
    this.valoresCicloAnterior = new Array(cantidad).fill(null);
    this.valoresCicloActual = [];
    this.reconnectTimer = null;
    this.esperandoRespuesta = false;
    this.cicloTimeout = null;
    this.ciclosCompletados = 0;
    this.maxCiclosSinReconectar = 50;
    this.procesoIntencional = false;
  }

  // MÉTODO CLAVE: Limpia absolutamente todo antes de destruir o reiniciar
  detener() {
    console.log(`[PLC ${this.ip}] Deteniendo cliente de forma absoluta...`);
    this.procesoIntencional = true;

    // 1. Limpiar todos los temporizadores
    this.limpiarTimeouts();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // 2. IMPORTANTE: Quitar listeners ANTES de destruir para evitar que el evento 'close' dispare reconexiones
    if (this.client) {
      this.client.removeAllListeners();
      this.client.destroy();
      this.client = null;
    }

    this.isConnected = false;
    this.esperandoRespuesta = false;
  }

  connect() {
    // Si ya existe un cliente, lo matamos bien antes de crear otro
    if (this.client) {
      this.detener();
    }

    this.procesoIntencional = false; // Resetear flag para permitir conexión
    this.client = new net.Socket({
      readableHighWaterMark: 256 * 1024,
      writableHighWaterMark: 256 * 1024,
    });

    this.client.setKeepAlive(true, 5000);
    this.client.setNoDelay(true);
    this.client.setTimeout(30000);

    this.client.on("connect", () => {
      this.isConnected = true;
      console.log(`Conectado a PLC ${this.ip}:${this.puerto}`);
      this.iniciarCiclo();
    });

    this.client.on("data", (data) => {
      this.buffer += data.toString();
      if (this.buffer.length > 10000) {
        this.buffer = "";
        return;
      }

      let delimiterIndex;
      while ((delimiterIndex = this.buffer.indexOf("\r\n")) !== -1) {
        const mensaje = this.buffer.substring(0, delimiterIndex).trim();
        this.buffer = this.buffer.substring(delimiterIndex + 2);
        if (mensaje.length > 0) {
          this.procesarRespuestaBloque(mensaje);
        }
      }
    });

    this.client.on("timeout", () => {
      console.warn("PLC NO RESPONDE (Timeout)");
      this.client.destroy();
    });

    this.client.on("error", (err) => {
      if (this.procesoIntencional) return;
      console.error(`Error de conexión PLC: ${err.message}`);
      this.isConnected = false;
      this.scheduleReconnect();
    });

    this.client.on("close", () => {
      if (this.procesoIntencional) {
        console.log("Cierre de socket intencional y limpio.");
        return;
      }
      console.warn("Conexión cerrada inesperadamente");
      this.isConnected = false;
      this.scheduleReconnect();
    });

    this.client.connect(this.puerto, this.ip);
  }

  limpiarTimeouts() {
    if (this.cicloTimeout) {
      clearTimeout(this.cicloTimeout);
      this.cicloTimeout = null;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.procesoIntencional) return;
    console.log("Reconectando en 5s...");
    this.limpiarTimeouts();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5000);
  }

  iniciarCiclo() {
    if (!this.isConnected || this.esperandoRespuesta || this.procesoIntencional)
      return;
    if (!this.client || !this.client.writable) return;

    this.esperandoRespuesta = true;
    const comando = `RDS DM${this.dmInicial} ${this.cantidad}`;

    try {
      this.client.write(comando + "\r\n", (err) => {
        if (err) {
          console.error(`Error al escribir: ${err.message}`);
          this.esperandoRespuesta = false;
        }
      });
    } catch (err) {
      console.error(`Excepción en escritura: ${err.message}`);
      this.esperandoRespuesta = false;
    }
  }

  procesarRespuestaBloque(mensaje) {
    if (this.procesoIntencional) return;

    if (mensaje.startsWith("E")) {
      console.error(`Error del PLC: ${mensaje}`);
      this.esperandoRespuesta = false;
      this.limpiarTimeouts();
      this.cicloTimeout = setTimeout(() => this.iniciarCiclo(), 2000);
      return;
    }

    const valoresRaw = mensaje.split(" ");
    this.valoresCicloActual = valoresRaw.map((v) => {
      const n = parseInt(v);
      return isNaN(n) ? null : n;
    });

    if (this.valoresCicloActual.length !== this.cantidad) {
      this.esperandoRespuesta = false;
      return;
    }

    this.finalizarCiclo();
  }

  finalizarCiclo() {
    if (this.procesoIntencional) return;

    // Comparación y envío de datos si hay cambios
    this.valoresCicloActual.forEach((valor, index) => {
      if (valor !== this.valoresCicloAnterior[index] && valor !== null) {
        this.sendData(valor, index + 1);
      }
    });

    //Define la variable de inicio contando el total y le resta 5
    //Si son 135 le resta 5 y da 130 que es la variable inicial de produccion
    let indiceInicioProgreso = this.valoresCicloActual.length - 5;
    //Defina la variable final que vendria siendo el conteo de todas estas
    let indiceFinProgreso = this.valoresCicloActual.length;

    //Una vez teniendo el indice se crea otro arreglo que corta el arreglo en la posicion indiceInicioProgreso
    //Hasta indiceFinProgreso
    const valoresProgreso = this.valoresCicloActual.slice(
      indiceInicioProgreso,
      indiceFinProgreso,
    );

    console.log("VALORES PRODUCCION: ", valoresProgreso);
    //El arreglo que se recorto se recorre uno en uno
    valoresProgreso.forEach((linea, index) => {
      //Si encuentra que un elemento de ese arreglo es 1
      if (linea != 1) {
        console.log("NO HAY PRODUCCION EN LA LINEA: ", index + 1);
      }

      if (linea == 1) {
        this.actualizarEstatus(index + 1);
      }
    });

    console.log(this.valoresCicloActual);
    console.log(`POOL: ${new Date()}`);
    this.valoresCicloAnterior = [...this.valoresCicloActual];
    this.esperandoRespuesta = false;
    this.ciclosCompletados++;

    // Reconexión preventiva revisada
    if (this.ciclosCompletados >= this.maxCiclosSinReconectar) {
      console.log(`Reconexión preventiva (${this.ciclosCompletados} ciclos)`);
      this.ciclosCompletados = 0;
      this.detener(); // Limpia todo
      setTimeout(() => {
        this.connect(); // Crea conexión nueva limpia
      }, 2000);
      return;
    }

    this.limpiarTimeouts();
    this.cicloTimeout = setTimeout(() => this.iniciarCiclo(), 1000);
  }

  async sendData(params) {
    try {
      await axios.post("URL", {
        props: props,
      });
      console.log("All good");
    } catch (err) {
      console.error(`Error enviando datos`);
    }
  }

  async actualizarEstatus(param) {
    try {
      await axios.post("URL");
    } catch (e) {
      console.log(`Error enviando datos`);
    }
  }
}
