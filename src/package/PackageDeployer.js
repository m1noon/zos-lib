import Logger from '../utils/Logger'
import Contracts from '../utils/Contracts'

const log = new Logger('PackageDeployer')

export default class PackageDeployer {
  constructor(txParams = {}) {
    this.txParams = txParams
  }

  async deploy(klass) {
    await this._createPackage()
    return new klass(this.package, this.txParams)
  }

  async _createPackage() {
    log.info('Deploying new Package...')
    const Package = Contracts.getFromLib('Package')
    this.package = await Package.new(this.txParams)
    log.info(`Deployed Package ${this.package.address}`)
  }
}
