import uuid
import .jaguar as jaguar
import .network show EndpointHttp

main args:
  device := jaguar.Device
      --id=(uuid.Uuid.parse "4d1c6a6e-9a8a-4a5c-8f0e-6c5f8f1d2b11")
      --name="Webby Host"
      --port=9123
      --chip="host"
      --config={"webby": {"url": args[0]}}
  jaguar.main device [EndpointHttp jaguar.logger]
