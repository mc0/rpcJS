var errorObject = function(errorCode, errorMessage) {
    this.errorCode = errorCode;
    this.errorMessage = errorMessage;
    this.string = JSON.stringify(this);
};

if ((module && module.exports || exports)) {
    module = module || {};
    module.exports = exports = errorObject;
}
